use crate::config::ProxyConfig;
use async_trait::async_trait;
use http::{Uri, uri::PathAndQuery};
use log::info;
use napi::Error as NapiError;
use napi::bindgen_prelude::Result as NapiResult;
use pingora::{
    prelude::*,
    services::background::{GenBackgroundService, background_service},
};
use pingora_load_balancing::health_check::TcpHealthCheck;
use std::{
    collections::HashMap,
    net::{SocketAddr, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};

pub type Cluster = LoadBalancer<RoundRobin>;

pub struct ClusterEntry {
    pub balancer: Arc<Cluster>,
    pub sni: Option<String>,
}

pub struct Router {
    clusters: HashMap<String, ClusterEntry>,
    upstreams_tls: HashMap<SocketAddr, bool>,
}

impl Router {
    fn new(
        clusters: HashMap<String, ClusterEntry>,
        upstreams_tls: HashMap<SocketAddr, bool>,
    ) -> Self {
        Self {
            clusters,
            upstreams_tls,
        }
    }

    fn cluster_for<'a>(&'a self, session: &Session) -> Option<&'a ClusterEntry> {
        if let Some(name) = extract_app_name(session) {
            if let Some(entry) = self.clusters.get(name) {
                return Some(entry);
            }
        }

        None
    }
}

#[async_trait]
impl ProxyHttp for Router {
    type CTX = ();

    fn new_ctx(&self) {}

    async fn upstream_peer(&self, session: &mut Session, _ctx: &mut ()) -> Result<Box<HttpPeer>> {
        const NO_CLUSTER: ImmutStr = ImmutStr::Static("no matching application for request");
        let cluster = self.cluster_for(session).ok_or_else(|| {
            Error::create(
                ErrorType::ConnectError,
                ErrorSource::Internal,
                Some(NO_CLUSTER),
                None,
            )
        })?;
        const NO_UPSTREAM: ImmutStr = ImmutStr::Static("no available upstream for application");
        let upstream = cluster.balancer.select(b"", 256).ok_or_else(|| {
            Error::create(
                ErrorType::ConnectError,
                ErrorSource::Internal,
                Some(NO_UPSTREAM),
                None,
            )
        })?;

        let sni = cluster
            .sni
            .clone()
            .or_else(|| session.req_header().uri.host().map(|h| h.to_string()))
            .or_else(|| {
                session
                    .req_header()
                    .headers
                    .get("host")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.split(':').next().unwrap_or(v).to_string())
            })
            .unwrap_or_default();

        let upstream_addr = upstream.addr.as_inet().ok_or_else(|| {
            Error::create(
                ErrorType::InternalError,
                ErrorSource::Internal,
                Some(ImmutStr::Static("upstream address is not inet")),
                None,
            )
        })?;
        let enable_tls = *self.upstreams_tls.get(upstream_addr).unwrap_or(&false);

        let peer = Box::new(HttpPeer::new(upstream, enable_tls, sni));
        Ok(peer)
    }

    async fn upstream_request_filter(
        &self,
        session: &mut Session,
        upstream_request: &mut RequestHeader,
        _ctx: &mut Self::CTX,
    ) -> Result<()> {
        let Some(name) = extract_app_name(session) else {
            return Ok(());
        };

        let path = upstream_request.uri.path();
        let path_bytes = path.as_bytes();
        let mut start_idx = 0;
        while start_idx < path_bytes.len() && path_bytes[start_idx] == b'/' {
            start_idx += 1;
        }

        if path[start_idx..].starts_with(name) {
            let end_idx = start_idx + name.len();
            if end_idx == path.len() || path_bytes[end_idx] == b'/' {
                let mut new_path = &path[end_idx..];
                if new_path.is_empty() {
                    new_path = "/";
                }

                let mut parts = upstream_request.uri.clone().into_parts();
                let path_and_query = if let Some(query) = upstream_request.uri.query() {
                    let mut s = String::with_capacity(new_path.len() + 1 + query.len());
                    s.push_str(new_path);
                    s.push('?');
                    s.push_str(query);
                    s
                } else {
                    new_path.to_string()
                };

                let pq = path_and_query.parse::<PathAndQuery>().map_err(|e| {
                    Error::create(
                        ErrorType::InternalError,
                        ErrorSource::Internal,
                        Some(ImmutStr::Static("invalid path")),
                        Some(Box::new(e)),
                    )
                })?;

                parts.path_and_query = Some(pq);
                let new_uri = Uri::from_parts(parts).map_err(|e| {
                    Error::create(
                        ErrorType::InternalError,
                        ErrorSource::Internal,
                        Some(ImmutStr::Static("invalid uri")),
                        Some(Box::new(e)),
                    )
                })?;

                upstream_request.set_uri(new_uri);
            }
        }
        Ok(())
    }
}

pub struct RouterAssembly {
    pub router: Router,
    pub background_services: Vec<GenBackgroundService<Cluster>>,
}

pub fn build_router(config: &ProxyConfig) -> NapiResult<RouterAssembly> {
    let mut services = Vec::with_capacity(config.apps.len());
    let mut clusters = HashMap::with_capacity(config.apps.len());
    let mut upstreams_tls = HashMap::new();

    for (name, definition) in &config.apps {
        let mut resolved_addrs = Vec::new();
        for upstream in &definition.upstreams {
            let addrs = upstream.address.to_socket_addrs().map_err(|e| {
                NapiError::from_reason(format!("failed to resolve '{}': {}", upstream.address, e))
            })?;
            for addr in addrs {
                resolved_addrs.push(addr);
                upstreams_tls.insert(addr, upstream.secure);
            }
        }

        let (balancer, service) =
            build_cluster_service(name, resolved_addrs, config.health_check_interval)?;

        clusters.insert(
            name.clone(),
            ClusterEntry {
                balancer,
                sni: definition.sni.clone(),
            },
        );
        if let Some(service) = service {
            services.push(service);
        }
    }

    let router = Router::new(clusters, upstreams_tls);
    Ok(RouterAssembly {
        router,
        background_services: services,
    })
}

fn build_cluster_service(
    name: &str,
    upstreams: Vec<SocketAddr>,
    health_interval: Option<Duration>,
) -> NapiResult<(Arc<Cluster>, Option<GenBackgroundService<Cluster>>)> {
    info!(
        "Building cluster for app '{name}' with upstreams: {:?}",
        upstreams
    );
    let mut balancer = LoadBalancer::try_from_iter(upstreams).map_err(|err| {
        NapiError::from_reason(format!(
            "failed to build load balancer for '{name}': {err:?}"
        ))
    })?;

    if let Some(interval) = health_interval {
        balancer.set_health_check(TcpHealthCheck::new());
        balancer.health_check_frequency = Some(interval);
        let service = background_service("cluster health check", balancer);
        Ok((service.task(), Some(service)))
    } else {
        Ok((Arc::new(balancer), None))
    }
}

fn extract_app_name(session: &Session) -> Option<&str> {
    let path = session.req_header().uri.path();
    let without_slash = path.trim_start_matches('/');
    without_slash.split('/').find(|segment| !segment.is_empty())
}
