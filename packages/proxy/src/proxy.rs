use crate::{errors, lb, options, router, runtime, server};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pingora::lb::health_check::TcpHealthCheck;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::net::{SocketAddr, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::io::IntoRawFd;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Mutex as TokioMutex, Notify, watch};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum ProxyState {
    Stopped,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Clone)]
enum StartStatus {
    Pending,
    Ready(std::result::Result<(), String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopStatus {
    Pending,
    Ready,
}

#[derive(Debug, Clone)]
struct DeferredJsError {
    code: &'static str,
    message: String,
}

type DeferredResult<T> = std::result::Result<T, DeferredJsError>;

impl DeferredJsError {
    fn generic(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn type_error(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

struct ProxyInner {
    options: options::ProxyOptionsParsed,
    state: ProxyState,
    listen_address: Option<BoundListenAddress>,
    start_notifier: Option<watch::Sender<StartStatus>>,
    stop_notifier: Option<watch::Sender<StopStatus>>,
    server: server::Server,
    router: Arc<router::Router>,
    // Upstreams are mutable; app definitions are immutable (from `options`).
    upstreams_by_app: HashMap<String, AppUpstreams>,
    // One pool per (app, transport), kept while it has members so backend health survives
    // membership changes.
    pools: HashMap<(String, lb::TransportKind), AppPool>,
}

/// An application's upstreams and the addresses each resolved to when it was added.
type AppUpstreams = HashMap<PortUpstream, Vec<SocketAddr>>;

#[derive(Clone)]
struct AppPool {
    config: router::PoolConfig,
    members: lb::Members,
    /// Wakes the pool's health task so backends added while running are probed right away.
    probe_now: Arc<Notify>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PortUpstream {
    transport: lb::TransportKind,
    secure: bool,
    hostname: String,
    port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BoundListenAddress {
    hostname: String,
    port: u16,
}

#[napi(object)]
pub struct ProxyAddress {
    pub hostname: String,
    pub port: u32,
}

impl From<SocketAddr> for BoundListenAddress {
    fn from(addr: SocketAddr) -> Self {
        Self {
            hostname: addr.ip().to_string(),
            port: addr.port(),
        }
    }
}

impl From<&BoundListenAddress> for ProxyAddress {
    fn from(address: &BoundListenAddress) -> Self {
        Self {
            hostname: address.hostname.clone(),
            port: address.port as u32,
        }
    }
}

#[napi(object)]
pub struct PortUpstreamOptions {
    #[napi(ts_type = " 'port' ")]
    pub r#type: String,
    #[napi(ts_type = " 'http' | 'http2' | 'ws' ")]
    pub transport: String,
    pub secure: bool,
    pub hostname: String,
    pub port: u32,
}

#[napi(object)]
pub struct UnixSocketUpstreamOptions {
    #[napi(ts_type = " 'unix' ")]
    pub r#type: String,
    #[napi(ts_type = " 'http' | 'http2' | 'ws' ")]
    pub transport: String,
    pub secure: bool,
    pub path: String,
}

#[napi(object)]
pub struct ProxyHealthStatus {
    /// Answers the health path with 200 when true, 503 otherwise.
    pub healthy: bool,
    /// Answers the ready path with 200 when true, 503 otherwise.
    pub ready: bool,
}

#[napi]
pub type UpstreamOptions = Either<PortUpstreamOptions, UnixSocketUpstreamOptions>;

#[napi(object)]
pub struct ApplicationUpstream {
    pub application: String,
    #[napi(ts_type = "UpstreamOptions")]
    pub upstream: UpstreamOptions,
}

#[napi]
pub struct Proxy {
    inner: Arc<Mutex<ProxyInner>>,
    update_lock: Arc<TokioMutex<()>>,
    runtime: Arc<runtime::ProxyRuntime>,
}

#[napi]
impl Proxy {
    #[napi(constructor)]
    pub fn new(env: Env, options: options::ProxyOptions) -> Result<Self> {
        let parsed = options::parse_proxy_options(&env, options)?;

        let router = Arc::new(router::Router::new(
            router::RouterConfig::default(),
            router::StickySessionConfig {
                enabled: parsed.sticky_sessions.enabled,
                cookie_name: parsed.sticky_sessions.cookie_name.clone(),
                header_name: parsed.sticky_sessions.header_name.clone(),
                ttl: Duration::from_millis(parsed.sticky_sessions.ttl_ms as u64),
                max_entries: parsed.sticky_sessions.max_entries,
                cookie_secure: parsed.tls.is_some(),
            },
            parsed.limits.clone(),
            parsed.timeouts.clone(),
            parsed.health.clone(),
        ));

        let runtime = runtime::ProxyRuntime::new(parsed.threads)
            .map_err(|e| {
                errors::generic_error(
                    &env,
                    errors::codes::RUNTIME_START_FAILED,
                    format!("Failed to start proxy runtime: {e}"),
                )
            })
            .map(Arc::new)?;

        let mut upstreams_by_app = HashMap::new();
        for app in &parsed.applications {
            upstreams_by_app.insert(app.name.clone(), AppUpstreams::new());
        }

        let inner = ProxyInner {
            options: parsed,
            state: ProxyState::Stopped,
            listen_address: None,
            start_notifier: None,
            stop_notifier: None,
            server: server::Server::new(),
            router,
            upstreams_by_app,
            pools: HashMap::new(),
        };

        // Initial router config: routes known, pools empty.
        let initial_config = build_router_config(&inner.options, &inner.pools);
        inner.router.update(initial_config);

        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            update_lock: Arc::new(TokioMutex::new(())),
            runtime,
        })
    }

    #[napi]
    pub fn start<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        let (listen, tls, proxy_runtime, server, inner, shared_router, mut start_rx) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;

            match guard.state {
                ProxyState::Starting => {
                    let Some(notifier) = guard.start_notifier.as_ref() else {
                        return Err(napi::Error::from_reason(
                            "Proxy internal error: missing start notifier",
                        ));
                    };

                    let mut rx = notifier.subscribe();
                    return spawn_deferred_result(env, self.runtime.clone(), async move {
                        Self::wait_for_start_ready(&mut rx).await.map(Ok)
                    });
                }
                ProxyState::Running => {
                    return Err(errors::generic_error(
                        env,
                        errors::codes::ALREADY_STARTED,
                        "Proxy is already started",
                    ));
                }
                ProxyState::Stopping => {
                    return Err(errors::generic_error(
                        env,
                        errors::codes::ALREADY_STARTED,
                        "Proxy is stopping",
                    ));
                }
                ProxyState::Stopped => {}
            }

            guard.state = ProxyState::Starting;
            guard.listen_address = None;
            let (start_notifier, start_rx) = watch::channel(StartStatus::Pending);
            guard.start_notifier = Some(start_notifier);

            let listen = guard.options.listen.clone();
            let tls = guard.options.tls.clone();
            let proxy_runtime = self.runtime.clone();
            let server = guard.server.clone();
            let inner = self.inner.clone();
            let shared_router =
                router::SharedRouter::new(guard.router.clone(), proxy_runtime.clone());
            (
                listen,
                tls,
                proxy_runtime,
                server,
                inner,
                shared_router,
                start_rx,
            )
        };

        let update_lock = self.update_lock.clone();

        // Move listener setup and service start behind the async boundary, then resolve once
        // startup is fully wired.
        let runtime = proxy_runtime.handle().clone();
        spawn_deferred_result(env, proxy_runtime, async move {
            let listen_for_setup = listen.clone();
            // A failed setup task takes the reset path below, so start and stop waiters settle.
            let setup_result =
                tokio::task::spawn_blocking(move || build_start_resources(&listen_for_setup, tls))
                    .await
                    .unwrap_or_else(|e| {
                        Err(DeferredJsError::generic(
                            "GenericFailure",
                            format!("Proxy start task failed during listener setup: {e}"),
                        ))
                    });

            let (std_listener, tls_settings, listen_address) = match setup_result {
                Ok(resources) => resources,
                Err(err) => {
                    if let Ok(mut guard) = inner.lock() {
                        guard.state = ProxyState::Stopped;
                        guard.listen_address = None;
                        if let Some(notifier) = guard.start_notifier.take() {
                            let _ = notifier.send(StartStatus::Ready(Err(err.message.clone())));
                        }
                    }

                    return Ok(Err(err));
                }
            };

            // Upstream updates spawn health tasks only once `Running`, so hold their lock from
            // reading pools until the state flips: each update either lands in this snapshot or
            // sees `Running` and starts its own task.
            let update_guard = update_lock.lock().await;
            let (lb_tasks, health_check_interval) = {
                let guard = inner
                    .lock()
                    .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;
                let tasks = guard
                    .pools
                    .iter()
                    .map(|((app, transport), pool)| {
                        (lb_service_name(app, *transport), pool.clone())
                    })
                    .collect::<Vec<_>>();
                (tasks, health_check_interval(&guard.options))
            };

            // Start LB health tasks first so pools become ready.
            for (svc_name, pool) in lb_tasks {
                server
                    .upsert_service(
                        svc_name,
                        spawn_pool_health_task(&runtime, &pool, health_check_interval),
                    )
                    .await;
            }

            // Hand the already-bound socket over to Pingora via the `ListenFds` table.
            // This ensures the bind attempt (and any bind errors) happen before Pingora
            // starts, avoiding its internal `expect("Failed to build listeners")` panic.
            #[cfg(unix)]
            let fd = std_listener.into_raw_fd();

            #[cfg(unix)]
            let mut fds = pingora::server::Fds::new();
            #[cfg(unix)]
            fds.add(listen.clone(), fd);

            #[cfg(unix)]
            let listen_fds: pingora::server::ListenFds = Arc::new(fds.into());

            let conf = Arc::new(pingora::server::configuration::ServerConf::default());
            let mut svc = pingora::proxy::http_proxy_service_with_name(
                &conf,
                shared_router,
                "Neemata Proxy (HTTP)",
            );
            if let Some(settings) = tls_settings {
                svc.add_tls_with_settings(&listen, None, settings);
            } else {
                svc.add_tcp(&listen);
            }

            let (shutdown, shutdown_rx) = watch::channel(false);
            // Pingora spawns connection tasks onto the runtime running `start_service`.
            let task = runtime.spawn(async move {
                use pingora::services::Service as _;
                #[cfg(unix)]
                svc.start_service(Some(listen_fds), shutdown_rx, conf.listener_tasks_per_fd)
                    .await;

                #[cfg(windows)]
                {
                    // Windows artifacts are not currently published. This fallback lets
                    // Pingora bind from `listen`, so `listen: ...:0` is not guaranteed to
                    // match `listen_address`; ephemeral-port reporting is supported on Unix.
                    svc.start_service(shutdown_rx, conf.listener_tasks_per_fd)
                        .await;
                }
            });

            server
                .upsert_service(
                    "main_http".to_string(),
                    server::ServiceHandle { shutdown, task },
                )
                .await;

            let start_result = {
                let mut guard = inner
                    .lock()
                    .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;

                let result = match guard.state {
                    ProxyState::Starting | ProxyState::Running => {
                        guard.state = ProxyState::Running;
                        guard.listen_address = Some(listen_address);
                        Ok(())
                    }
                    ProxyState::Stopping | ProxyState::Stopped => {
                        Err("Proxy start was cancelled while stopping".to_string())
                    }
                };

                if let Some(notifier) = guard.start_notifier.take() {
                    let _ = notifier.send(StartStatus::Ready(result.clone()));
                }

                result
            };
            drop(update_guard);

            if start_result.is_err() {
                server.stop_all().await;
                let mut guard = inner
                    .lock()
                    .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;
                guard.state = ProxyState::Stopped;
                guard.listen_address = None;
                return Err(napi::Error::from_reason(
                    "Proxy start was cancelled while stopping",
                ));
            }

            Self::wait_for_start_ready(&mut start_rx).await?;
            Ok(Ok(()))
        })
    }

    #[napi]
    pub fn stop<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        let (runtime, server, inner, mut start_rx) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;

            match guard.state {
                ProxyState::Stopped => {
                    guard.listen_address = None;
                    return PromiseRaw::resolve(env, ());
                }
                ProxyState::Stopping => {
                    let Some(notifier) = guard.stop_notifier.as_ref() else {
                        return Err(napi::Error::from_reason(
                            "Proxy internal error: missing stop notifier",
                        ));
                    };

                    let mut rx = notifier.subscribe();
                    return spawn_deferred_result(env, self.runtime.clone(), async move {
                        Self::wait_for_stop_ready(&mut rx).await.map(Ok)
                    });
                }
                ProxyState::Starting | ProxyState::Running => {
                    guard.state = ProxyState::Stopping;
                    if guard.stop_notifier.is_none() {
                        let (stop_notifier, _) = watch::channel(StopStatus::Pending);
                        guard.stop_notifier = Some(stop_notifier);
                    }
                }
            }

            (
                self.runtime.clone(),
                guard.server.clone(),
                self.inner.clone(),
                guard.start_notifier.as_ref().map(watch::Sender::subscribe),
            )
        };

        spawn_deferred_result(env, runtime, async move {
            if let Some(rx) = start_rx.as_mut() {
                let _ = Self::wait_for_start_ready(rx).await;
            }

            server.stop_all().await;
            if let Ok(mut guard) = inner.lock() {
                guard.state = ProxyState::Stopped;
                guard.listen_address = None;
                guard.start_notifier = None;
                if let Some(notifier) = guard.stop_notifier.take() {
                    let _ = notifier.send(StopStatus::Ready);
                }
            }
            Ok(Ok(()))
        })
    }

    async fn wait_for_start_ready(rx: &mut watch::Receiver<StartStatus>) -> Result<()> {
        loop {
            let status = rx.borrow().clone();
            match status {
                StartStatus::Pending => {
                    if rx.changed().await.is_err() {
                        return Err(napi::Error::from_reason(
                            "Proxy start channel closed unexpectedly",
                        ));
                    }
                }
                StartStatus::Ready(Ok(())) => return Ok(()),
                StartStatus::Ready(Err(msg)) => return Err(napi::Error::from_reason(msg)),
            }
        }
    }

    async fn wait_for_stop_ready(rx: &mut watch::Receiver<StopStatus>) -> Result<()> {
        loop {
            let status = *rx.borrow();
            match status {
                StopStatus::Pending => {
                    if rx.changed().await.is_err() {
                        return Err(napi::Error::from_reason(
                            "Proxy stop channel closed unexpectedly",
                        ));
                    }
                }
                StopStatus::Ready => return Ok(()),
            }
        }
    }

    /// Sets the status served on the health endpoints. Starts as healthy and not ready.
    #[napi]
    pub fn set_health(&self, status: ProxyHealthStatus) -> Result<()> {
        let router = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?
            .router
            .clone();
        router.set_health(router::HealthStatus {
            healthy: status.healthy,
            ready: status.ready,
        });
        Ok(())
    }

    #[napi]
    pub fn address(&self) -> Result<Option<ProxyAddress>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;

        if guard.state != ProxyState::Running {
            return Ok(None);
        }

        Ok(guard.listen_address.as_ref().map(ProxyAddress::from))
    }

    #[napi]
    pub fn add_upstream<'env>(
        &self,
        env: &'env Env,
        app_name: String,
        upstream: UpstreamOptions,
    ) -> Result<PromiseRaw<'env, ()>> {
        let upstream = parse_port_upstream(env, upstream)?;

        self.update_upstreams(env, move |current| {
            let Some(upstreams) = current.get(&app_name) else {
                return Err(unknown_application(&app_name));
            };
            if upstreams.contains_key(&upstream) {
                return Err(DeferredJsError::generic(
                    errors::codes::UPSTREAM_ALREADY_EXISTS,
                    "Upstream already exists",
                ));
            }

            let mut next = upstreams.keys().cloned().collect::<HashSet<_>>();
            next.insert(upstream);
            Ok(HashMap::from([(app_name, next)]))
        })
    }

    #[napi]
    pub fn remove_upstream<'env>(
        &self,
        env: &'env Env,
        app_name: String,
        upstream: UpstreamOptions,
    ) -> Result<PromiseRaw<'env, ()>> {
        let upstream = parse_port_upstream(env, upstream)?;

        self.update_upstreams(env, move |current| {
            let Some(upstreams) = current.get(&app_name) else {
                return Err(unknown_application(&app_name));
            };
            if !upstreams.contains_key(&upstream) {
                return Err(DeferredJsError::generic(
                    errors::codes::UPSTREAM_NOT_FOUND,
                    "Upstream not found",
                ));
            }

            let mut next = upstreams.keys().cloned().collect::<HashSet<_>>();
            next.remove(&upstream);
            Ok(HashMap::from([(app_name, next)]))
        })
    }

    /// Replaces the upstreams of every application: those not listed are left with none. The
    /// whole list is validated first, so an invalid entry rejects the call and changes nothing.
    #[napi]
    pub fn set_upstreams<'env>(
        &self,
        env: &'env Env,
        upstreams: Vec<ApplicationUpstream>,
    ) -> Result<PromiseRaw<'env, ()>> {
        let entries = upstreams
            .into_iter()
            .map(|entry| Ok((entry.application, parse_port_upstream(env, entry.upstream)?)))
            .collect::<Result<Vec<_>>>()?;

        self.update_upstreams(env, move |current| {
            let mut next = current
                .keys()
                .map(|app| (app.clone(), HashSet::new()))
                .collect::<HashMap<_, _>>();
            for (app_name, upstream) in entries {
                let Some(upstreams) = next.get_mut(&app_name) else {
                    return Err(unknown_application(&app_name));
                };
                if !upstreams.insert(upstream) {
                    return Err(DeferredJsError::generic(
                        errors::codes::UPSTREAM_ALREADY_EXISTS,
                        format!("Upstream is listed twice for application '{app_name}'"),
                    ));
                }
            }
            Ok(next)
        })
    }

    /// Serializes a membership change with other changes and with `start()`. `plan` maps the
    /// current upstreams to the next upstream sets of the applications to change.
    fn update_upstreams<'env, F>(&self, env: &'env Env, plan: F) -> Result<PromiseRaw<'env, ()>>
    where
        F: FnOnce(
                &HashMap<String, AppUpstreams>,
            ) -> DeferredResult<HashMap<String, HashSet<PortUpstream>>>
            + Send
            + 'static,
    {
        let inner = self.inner.clone();
        let update_lock = self.update_lock.clone();
        let runtime = self.runtime.handle().clone();

        spawn_deferred_result(env, self.runtime.clone(), async move {
            let _update_guard = update_lock.lock().await;
            apply_upstreams(&inner, &runtime, plan).await
        })
    }
}

/// Validates the next upstream sets, then updates the affected pools and publishes them to the
/// router once. The caller holds `update_lock`.
async fn apply_upstreams<F>(
    inner: &Mutex<ProxyInner>,
    runtime: &tokio::runtime::Handle,
    plan: F,
) -> Result<DeferredResult<()>>
where
    F: FnOnce(
        &HashMap<String, AppUpstreams>,
    ) -> DeferredResult<HashMap<String, HashSet<PortUpstream>>>,
{
    let (server, health_check_interval, next, apps, current, current_pools) = {
        let guard = inner
            .lock()
            .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;

        let next = match plan(&guard.upstreams_by_app) {
            Ok(next) => next,
            Err(err) => return Ok(Err(err)),
        };

        let mut apps = HashMap::new();
        let mut current = HashMap::new();
        for app_name in next.keys() {
            let (Some(app), Some(upstreams)) = (
                guard
                    .options
                    .applications
                    .iter()
                    .find(|a| &a.name == app_name),
                guard.upstreams_by_app.get(app_name),
            ) else {
                return Ok(Err(unknown_application(app_name)));
            };
            apps.insert(app_name.clone(), app.clone());
            current.insert(app_name.clone(), upstreams.clone());
        }

        let current_pools = guard
            .pools
            .iter()
            .filter(|((app_name, _), _)| next.contains_key(app_name))
            .map(|(key, pool)| (key.clone(), pool.clone()))
            .collect::<HashMap<_, _>>();

        (
            guard.server.clone(),
            health_check_interval(&guard.options),
            next,
            apps,
            current,
            current_pools,
        )
    };

    let mut pool_tls = HashMap::new();
    for (app_name, upstreams) in &next {
        match validate_pool_tls(&apps[app_name], upstreams) {
            Ok(tls) => pool_tls.insert(app_name.clone(), tls),
            Err(err) => return Ok(Err(err)),
        };
    }

    // Retained upstreams keep the addresses they resolved to; only new ones are looked up.
    let to_resolve = next
        .iter()
        .flat_map(|(app_name, upstreams)| {
            upstreams
                .iter()
                .filter(|u| !current[app_name].contains_key(*u))
                .cloned()
        })
        .collect::<HashSet<_>>();
    let resolved = tokio::task::spawn_blocking(move || resolve_upstreams(to_resolve))
        .await
        .map_err(|e| napi::Error::from_reason(format!("Upstream resolution task failed: {e}")))?;
    let resolved = match resolved {
        Ok(resolved) => resolved,
        Err(err) => return Ok(Err(err)),
    };

    let next = next
        .into_iter()
        .map(|(app_name, upstreams)| {
            let upstreams = upstreams
                .into_iter()
                .map(|u| {
                    let addrs = current[&app_name]
                        .get(&u)
                        .unwrap_or_else(|| &resolved[&u])
                        .clone();
                    (u, addrs)
                })
                .collect::<AppUpstreams>();
            (app_name, upstreams)
        })
        .collect::<HashMap<_, _>>();

    // Nothing below can fail, so the change applies completely.
    let mut created = Vec::new();
    let mut removed = Vec::new();
    let mut to_probe = Vec::new();
    for (app_name, upstreams) in &next {
        let old_members = pool_members(&current[app_name]);
        let mut new_members = pool_members(upstreams);
        for transport in [
            lb::TransportKind::Http1,
            lb::TransportKind::Http2,
            lb::TransportKind::Ws,
        ] {
            let key = (app_name.clone(), transport);
            match (current_pools.get(&key), new_members.remove(&transport)) {
                (Some(pool), Some(addrs))
                    if pool.config.secure == pool_tls[app_name][&transport].0 =>
                {
                    let old = old_members.get(&transport);
                    if old == Some(&addrs) {
                        continue;
                    }
                    pool.members.set(&addrs);
                    // Requests holding this pool see the new membership; retained backends keep
                    // their health.
                    update_lb(&pool.config.lb).await?;
                    if old.is_none_or(|old| !addrs.is_subset(old)) {
                        to_probe.push(pool.probe_now.clone());
                    }
                }
                // A new pool, or one whose upstreams switched between plain and TLS.
                (_, Some(addrs)) => {
                    let (secure, verify_hostname) = pool_tls[app_name][&transport].clone();
                    let pool = new_pool(&addrs, secure, verify_hostname).await?;
                    created.push((key, pool));
                }
                (Some(_), None) => removed.push(key),
                (None, None) => {}
            }
        }
    }

    let is_running = {
        let mut guard = inner
            .lock()
            .map_err(|_| napi::Error::from_reason("Proxy mutex poisoned"))?;

        for (app_name, upstreams) in next {
            guard.upstreams_by_app.insert(app_name, upstreams);
        }
        for (key, pool) in &created {
            guard.pools.insert(key.clone(), pool.clone());
        }
        for key in &removed {
            guard.pools.remove(key);
        }

        let cfg = build_router_config(&guard.options, &guard.pools);
        guard.router.update(cfg);

        guard.state == ProxyState::Running
    };

    // While stopped, `start()` spawns every pool's health task, which probes right away.
    if is_running {
        for ((app_name, transport), pool) in created {
            server
                .upsert_service(
                    lb_service_name(&app_name, transport),
                    spawn_pool_health_task(runtime, &pool, health_check_interval),
                )
                .await;
        }
        for (app_name, transport) in removed {
            server
                .remove_service(&lb_service_name(&app_name, transport))
                .await;
        }
        for probe_now in to_probe {
            probe_now.notify_one();
        }
    }

    Ok(Ok(()))
}

/// Runs a control-plane operation on the proxy's runtime and settles its promise from a
/// supervisor task, which turns panics into rejections. The supervisor holds the runtime until
/// the promise is settled, so the runtime cannot shut down under a pending promise.
fn spawn_deferred_result<'env, F>(
    env: &'env Env,
    runtime: Arc<runtime::ProxyRuntime>,
    fut: F,
) -> Result<PromiseRaw<'env, ()>>
where
    F: 'static + Send + Future<Output = Result<DeferredResult<()>>>,
{
    let (deferred, promise) = env.create_deferred()?;
    let handle = runtime.handle().clone();
    let job = handle.spawn(fut);
    handle.spawn(async move {
        match job.await {
            Ok(Ok(result)) => deferred.resolve(move |env| {
                // Built on the JS thread so the rejection carries the proxy error code.
                result.map_err(|err| {
                    JsError::from(napi::Error::new(err.code, err.message))
                        .into_unknown(env)
                        .into()
                })
            }),
            Ok(Err(err)) => deferred.reject(err),
            Err(err) => deferred.reject(napi::Error::from_reason(format!(
                "Proxy operation failed: {err}"
            ))),
        }
        drop(runtime);
    });

    Ok(PromiseRaw::new(env.raw(), promise.raw()))
}

fn build_start_resources(
    listen: &str,
    tls: Option<options::ListenerTlsOptionsParsed>,
) -> DeferredResult<(
    std::net::TcpListener,
    Option<pingora::listeners::tls::TlsSettings>,
    BoundListenAddress,
)> {
    let std_listener = std::net::TcpListener::bind(listen).map_err(|e| {
        DeferredJsError::generic(
            errors::codes::LISTEN_BIND_FAILED,
            format!("Failed to bind listener on '{listen}': {e}"),
        )
    })?;

    let listen_address = std_listener.local_addr().map_err(|e| {
        DeferredJsError::generic(
            errors::codes::LISTEN_BIND_FAILED,
            format!("Failed to read bound listener address for '{listen}': {e}"),
        )
    })?;

    std_listener.set_nonblocking(true).map_err(|e| {
        DeferredJsError::generic(
            errors::codes::LISTEN_BIND_FAILED,
            format!("Failed to set listener nonblocking: {e}"),
        )
    })?;

    let tls_settings = if let Some(tls) = tls {
        let mut settings =
            pingora::listeners::tls::TlsSettings::intermediate(&tls.cert_path, &tls.key_path)
                .map_err(|e| {
                    DeferredJsError::type_error(
                        errors::codes::INVALID_PROXY_OPTIONS,
                        format!(
                            "Failed to configure TLS using cert '{}' and key '{}': {e}",
                            tls.cert_path, tls.key_path
                        ),
                    )
                })?;

        if tls.enable_h2 {
            settings.enable_h2();
        }

        Some(settings)
    } else {
        None
    };

    Ok((std_listener, tls_settings, listen_address.into()))
}

fn build_router_config(
    options: &options::ProxyOptionsParsed,
    pools: &HashMap<(String, lb::TransportKind), AppPool>,
) -> router::RouterConfig {
    let mut cfg = router::RouterConfig::default();

    for app in &options.applications {
        match &app.routing {
            options::ApplicationRoutingParsed::Subdomain { name } => {
                cfg.subdomain_routes
                    .insert(name.to_ascii_lowercase(), app.name.clone());
            }
            options::ApplicationRoutingParsed::Path { name } => {
                cfg.path_routes.insert(name.clone(), app.name.clone());
            }
            options::ApplicationRoutingParsed::Default => {
                cfg.default_app = Some(app.name.clone());
            }
        }

        let http1 = pools
            .get(&(app.name.clone(), lb::TransportKind::Http1))
            .map(|pool| pool.config.clone());
        let ws = pools
            .get(&(app.name.clone(), lb::TransportKind::Ws))
            .map(|pool| pool.config.clone());
        let http2 = pools
            .get(&(app.name.clone(), lb::TransportKind::Http2))
            .map(|pool| pool.config.clone());
        cfg.apps
            .insert(app.name.clone(), router::AppPools { http1, ws, http2 });
        if let Some(limit) = app.max_request_body_bytes {
            cfg.max_request_body_bytes.insert(app.name.clone(), limit);
        }
    }

    cfg
}

fn lb_service_name(app: &str, transport: lb::TransportKind) -> String {
    match transport {
        lb::TransportKind::Http1 => format!("lb:{app}:http"),
        lb::TransportKind::Http2 => format!("lb:{app}:http2"),
        lb::TransportKind::Ws => format!("lb:{app}:ws"),
    }
}

fn parse_port_upstream(env: &Env, upstream: UpstreamOptions) -> Result<PortUpstream> {
    match upstream {
        Either::A(port) => {
            if port.r#type != "port" {
                return Err(errors::generic_error(
                    env,
                    errors::codes::UNSUPPORTED_UPSTREAM_TYPE,
                    format!("Unsupported upstream type '{}'", port.r#type),
                ));
            }

            let transport = match port.transport.as_str() {
                "http" => lb::TransportKind::Http1,
                "http2" => lb::TransportKind::Http2,
                "ws" => lb::TransportKind::Ws,
                other => {
                    return errors::throw_type_error(
                        env,
                        errors::codes::INVALID_PROXY_OPTIONS,
                        format!("Unknown upstream transport '{other}'"),
                    );
                }
            };

            if port.port == 0 || port.port > u16::MAX as u32 {
                return errors::throw_type_error(
                    env,
                    errors::codes::INVALID_PROXY_OPTIONS,
                    "PortUpstreamOptions.port must be in range 1..=65535",
                );
            }

            if port.hostname.is_empty() {
                return errors::throw_type_error(
                    env,
                    errors::codes::INVALID_PROXY_OPTIONS,
                    "PortUpstreamOptions.hostname must be non-empty",
                );
            }

            Ok(PortUpstream {
                transport,
                secure: port.secure,
                hostname: port.hostname,
                port: port.port as u16,
            })
        }
        Either::B(unix) => {
            if unix.r#type != "unix" && unix.r#type != "unix_socket" {
                return Err(errors::generic_error(
                    env,
                    errors::codes::UNSUPPORTED_UPSTREAM_TYPE,
                    format!("Unsupported upstream type '{}'", unix.r#type),
                ));
            }
            Err(errors::generic_error(
                env,
                errors::codes::UNSUPPORTED_UPSTREAM_TYPE,
                "unix_socket upstreams are not supported",
            ))
        }
    }
}

fn verify_hostname_for_secure_upstream(
    app: &options::ApplicationOptionsParsed,
) -> DeferredResult<String> {
    match &app.routing {
        options::ApplicationRoutingParsed::Subdomain { name } => Ok(name.clone()),
        options::ApplicationRoutingParsed::Path { .. }
        | options::ApplicationRoutingParsed::Default => {
            let Some(sni) = &app.sni else {
                return Err(DeferredJsError::type_error(
                    errors::codes::INVALID_APPLICATION_OPTIONS,
                    "ApplicationOptions.sni is required when using secure upstreams for path/default routing",
                ));
            };
            Ok(sni.clone())
        }
    }
}

fn unknown_application(app_name: &str) -> DeferredJsError {
    DeferredJsError::generic(
        errors::codes::UNKNOWN_APPLICATION,
        format!("Unknown application '{app_name}'"),
    )
}

fn health_check_interval(options: &options::ProxyOptionsParsed) -> Duration {
    Duration::from_millis(options.health_check_interval_ms as u64)
}

fn spawn_pool_health_task(
    runtime: &tokio::runtime::Handle,
    pool: &AppPool,
    interval: Duration,
) -> server::ServiceHandle {
    lb::spawn_lb_health_task(
        runtime,
        pool.config.lb.clone(),
        pool.probe_now.clone(),
        interval,
    )
}

/// Returns `(secure, verify_hostname)` per transport. A pool must be all TLS or all plain, and
/// TLS pools need a hostname to verify.
fn validate_pool_tls(
    app: &options::ApplicationOptionsParsed,
    upstreams: &HashSet<PortUpstream>,
) -> DeferredResult<HashMap<lb::TransportKind, (bool, String)>> {
    let mut secure_by_transport = HashMap::new();
    for u in upstreams {
        if *secure_by_transport.entry(u.transport).or_insert(u.secure) != u.secure {
            return Err(DeferredJsError::type_error(
                errors::codes::INVALID_PROXY_OPTIONS,
                "Mixing secure and insecure upstreams within the same (app, transport) pool is not supported",
            ));
        }
    }

    secure_by_transport
        .into_iter()
        .map(|(transport, secure)| {
            let verify_hostname = if secure {
                verify_hostname_for_secure_upstream(app)?
            } else {
                String::new()
            };
            Ok((transport, (secure, verify_hostname)))
        })
        .collect()
}

/// Blocking: may look hostnames up in DNS.
fn resolve_upstreams(
    upstreams: HashSet<PortUpstream>,
) -> DeferredResult<HashMap<PortUpstream, Vec<SocketAddr>>> {
    upstreams
        .into_iter()
        .map(|u| {
            let addrs = (u.hostname.as_str(), u.port)
                .to_socket_addrs()
                .map_err(|e| {
                    DeferredJsError::type_error(
                        errors::codes::INVALID_PROXY_OPTIONS,
                        format!(
                            "Failed to resolve upstream '{}:{}': {e}",
                            u.hostname, u.port
                        ),
                    )
                })?
                .collect::<Vec<_>>();
            if addrs.is_empty() {
                return Err(DeferredJsError::type_error(
                    errors::codes::INVALID_PROXY_OPTIONS,
                    format!(
                        "Failed to resolve upstream '{}:{}': no addresses were returned",
                        u.hostname, u.port
                    ),
                ));
            }
            Ok((u, addrs))
        })
        .collect()
}

/// The backend addresses of each of an application's pools. Upstreams resolving to the same
/// address share one backend, which stays while any of them remains.
fn pool_members(upstreams: &AppUpstreams) -> HashMap<lb::TransportKind, BTreeSet<SocketAddr>> {
    let mut members = HashMap::<_, BTreeSet<_>>::new();
    for (u, addrs) in upstreams {
        members
            .entry(u.transport)
            .or_default()
            .extend(addrs.iter().copied());
    }
    members
}

async fn update_lb(
    lb: &pingora::lb::LoadBalancer<pingora::lb::selection::RoundRobin>,
) -> Result<()> {
    // `lb::Members` discovery never fails, so this is not reachable in practice.
    lb.update()
        .await
        .map_err(|e| napi::Error::from_reason(format!("Failed to update load balancer: {e}")))
}

async fn new_pool(
    addrs: &BTreeSet<SocketAddr>,
    secure: bool,
    verify_hostname: String,
) -> Result<AppPool> {
    let members = lb::Members::default();
    members.set(addrs);
    let mut lb = lb::new_round_robin_lb(members.clone());
    if secure {
        lb.set_health_check(TcpHealthCheck::new_tls(&verify_hostname));
    } else {
        lb.set_health_check(TcpHealthCheck::new());
    }
    // Backends start healthy, so the pool routes to them as soon as it is published. Its health
    // task probes right away, then every interval; one failed or successful probe flips a
    // backend's health.
    update_lb(&lb).await?;

    Ok(AppPool {
        config: router::PoolConfig {
            lb: Arc::new(lb),
            secure,
            verify_hostname,
        },
        members,
        probe_now: Arc::new(Notify::new()),
    })
}

#[cfg(test)]
mod tests {
    use super::{AppUpstreams, PortUpstream, pool_members};
    use crate::lb::TransportKind;
    use std::collections::BTreeSet;
    use std::net::SocketAddr;

    fn upstream(transport: TransportKind, hostname: &str, port: u16) -> PortUpstream {
        PortUpstream {
            transport,
            secure: false,
            hostname: hostname.to_string(),
            port,
        }
    }

    fn addr(port: u16) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    #[test]
    fn pool_members_split_by_transport_and_share_addresses() {
        let mut upstreams = AppUpstreams::new();
        upstreams.insert(
            upstream(TransportKind::Http1, "localhost", 3000),
            vec![addr(3000)],
        );
        upstreams.insert(
            upstream(TransportKind::Http1, "127.0.0.1", 3000),
            vec![addr(3000)],
        );
        upstreams.insert(
            upstream(TransportKind::Http1, "127.0.0.1", 3001),
            vec![addr(3001)],
        );
        upstreams.insert(
            upstream(TransportKind::Ws, "127.0.0.1", 3002),
            vec![addr(3002)],
        );

        let members = pool_members(&upstreams);
        assert_eq!(
            members[&TransportKind::Http1],
            BTreeSet::from([addr(3000), addr(3001)])
        );
        assert_eq!(members[&TransportKind::Ws], BTreeSet::from([addr(3002)]));
        assert!(!members.contains_key(&TransportKind::Http2));

        // The shared address stays while one upstream that resolved to it remains.
        upstreams.remove(&upstream(TransportKind::Http1, "localhost", 3000));
        assert_eq!(
            pool_members(&upstreams)[&TransportKind::Http1],
            BTreeSet::from([addr(3000), addr(3001)])
        );
    }
}
