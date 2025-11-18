use crate::config::{AppDefinition, GatewayConfig};
use async_trait::async_trait;
use napi::bindgen_prelude::Result as NapiResult;
use napi::Error as NapiError;
use pingora::{
    prelude::*,
    services::background::{background_service, GenBackgroundService},
};
use pingora_load_balancing::health_check::TcpHealthCheck;
use std::{
    collections::HashMap,
    sync::Arc,
    time::Duration,
};

pub type Cluster = LoadBalancer<RoundRobin>;

pub struct ClusterEntry {
    pub balancer: Arc<Cluster>,
    pub sni: Option<String>,
    pub enable_tls: bool,
}

pub struct Router {
    clusters: HashMap<String, ClusterEntry>,
}

impl Router {
    fn new(clusters: HashMap<String, ClusterEntry>) -> Self {
        Self { clusters }
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
        let entry = self
            .cluster_for(session)
            .ok_or_else(|| Error::create(ErrorType::ConnectError, ErrorSource::Internal, Some(NO_CLUSTER), None))?;
        const NO_UPSTREAM: ImmutStr = ImmutStr::Static("no available upstream for application");
        let upstream = entry
            .balancer
            .select(b"", 256)
            .ok_or_else(|| Error::create(ErrorType::ConnectError, ErrorSource::Internal, Some(NO_UPSTREAM), None))?;

        let sni = entry
            .sni
            .clone()
            .or_else(|| session.req_header().uri.host().map(|h| h.to_string()))
            .unwrap_or_default();

        let peer = Box::new(HttpPeer::new(upstream, entry.enable_tls, sni));
        Ok(peer)
    }
}

pub struct RouterAssembly {
    pub router: Router,
    pub background_services: Vec<GenBackgroundService<Cluster>>,
}

pub fn build_router(config: &GatewayConfig) -> NapiResult<RouterAssembly> {
    let mut services = Vec::with_capacity(config.apps.len());
    let mut clusters = HashMap::with_capacity(config.apps.len());

    for (name, definition) in &config.apps {
        let service = build_cluster_service(name, definition, config.health_check_interval)?;
        let balancer = service.task();
        clusters.insert(
            name.clone(),
            ClusterEntry {
                balancer,
                sni: definition.sni.clone(),
                enable_tls: definition.enable_tls,
            },
        );
        services.push(service);
    }

    let router = Router::new(clusters);
    Ok(RouterAssembly {
        router,
        background_services: services,
    })
}

fn build_cluster_service(
    name: &str,
    definition: &AppDefinition,
    health_interval: Option<Duration>,
) -> NapiResult<GenBackgroundService<Cluster>> {
    let upstream_refs: Vec<&str> = definition.upstreams.iter().map(String::as_str).collect();
    let mut balancer = LoadBalancer::try_from_iter(upstream_refs).map_err(|err| {
        NapiError::from_reason(format!(
            "failed to build load balancer for '{name}': {err:?}"
        ))
    })?;

    if let Some(interval) = health_interval {
        balancer.set_health_check(TcpHealthCheck::new());
        balancer.health_check_frequency = Some(interval);
    }

    Ok(background_service("cluster health check", balancer))
}

fn extract_app_name(session: &Session) -> Option<&str> {
    let path = session.req_header().uri.path();
    let without_slash = path.trim_start_matches('/');
    without_slash
        .split('/')
        .find(|segment| !segment.is_empty())
}
