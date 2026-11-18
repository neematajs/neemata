use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use pingora::lb::discovery::ServiceDiscovery;
use pingora::lb::{Backend, LoadBalancer, selection::RoundRobin};
use pingora::protocols::l4::socket::SocketAddr as PeerAddr;
use tokio::{
    runtime::Handle,
    sync::{Notify, watch},
};

use crate::server::ServiceHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[allow(dead_code)]
pub enum TransportKind {
    Http1,
    Http2,
    Ws,
}

/// The membership of one long-lived load balancer. Pingora's `Static` discovery cannot be
/// changed from outside its crate, so this is the source `LoadBalancer::update` reads.
#[derive(Clone, Default)]
pub struct Members(Arc<ArcSwap<BTreeSet<Backend>>>);

impl Members {
    pub fn set(&self, addrs: &BTreeSet<SocketAddr>) {
        let backends = addrs
            .iter()
            .map(|addr| Backend {
                addr: PeerAddr::Inet(*addr),
                weight: 1,
                ext: http::Extensions::new(),
            })
            .collect();
        self.0.store(Arc::new(backends));
    }
}

#[async_trait::async_trait]
impl ServiceDiscovery for Members {
    async fn discover(&self) -> pingora::Result<(BTreeSet<Backend>, HashMap<u64, bool>)> {
        Ok((BTreeSet::clone(&self.0.load()), HashMap::new()))
    }
}

/// Builds a load balancer fed by `members`. Its backends keep their health across later
/// `members.set()` + `lb.update()` calls; only backends new to it start healthy.
pub fn new_round_robin_lb(members: Members) -> LoadBalancer<RoundRobin> {
    LoadBalancer::from_backends(pingora::lb::Backends::new(Box::new(members)))
}

/// Probes `lb`'s backends right away, then every `interval` and whenever `probe_now` is
/// notified, until shut down. Replaces `LoadBalancer::start`, which can only probe on its
/// fixed schedule, so backends added to a running pool are checked immediately.
pub fn spawn_lb_health_task(
    runtime: &Handle,
    lb: Arc<LoadBalancer<RoundRobin>>,
    probe_now: Arc<Notify>,
    interval: Duration,
) -> ServiceHandle {
    let (shutdown, mut shutdown_rx) = watch::channel(false);

    let task = runtime.spawn(async move {
        loop {
            // Shutdown drops an in-flight pass; unreported backends keep their health.
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => return,
                () = lb.backends().run_health_check(false) => {}
            }
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => return,
                () = tokio::time::sleep(interval) => {}
                () = probe_now.notified() => {}
            }
        }
    });

    ServiceHandle { shutdown, task }
}

#[cfg(test)]
mod tests {
    use super::{Members, new_round_robin_lb};
    use pingora::lb::Backend;
    use pingora::lb::health_check::HealthCheck;
    use std::collections::BTreeSet;
    use std::net::SocketAddr;

    /// Fails every probe, so any backend it checks is marked down.
    struct FailAll;

    #[async_trait::async_trait]
    impl HealthCheck for FailAll {
        async fn check(&self, _target: &Backend) -> pingora::Result<()> {
            Err(pingora::Error::new_str("down"))
        }

        fn health_threshold(&self, _success: bool) -> usize {
            1
        }
    }

    fn addrs(ports: &[u16]) -> BTreeSet<SocketAddr> {
        ports
            .iter()
            .map(|port| SocketAddr::from(([127, 0, 0, 1], *port)))
            .collect()
    }

    fn backend(port: u16) -> Backend {
        Backend::new(&format!("127.0.0.1:{port}")).unwrap()
    }

    #[tokio::test]
    async fn membership_updates_keep_the_health_of_retained_backends() {
        let members = Members::default();
        members.set(&addrs(&[1, 2]));
        let mut lb = new_round_robin_lb(members.clone());
        lb.set_health_check(Box::new(FailAll));
        lb.update().await.unwrap();

        lb.backends().run_health_check(false).await;
        assert!(!lb.backends().ready(&backend(1)));
        assert!(!lb.backends().ready(&backend(2)));

        members.set(&addrs(&[1, 3]));
        lb.update().await.unwrap();

        assert!(
            !lb.backends().ready(&backend(1)),
            "retained backend stays down"
        );
        assert!(lb.backends().ready(&backend(3)), "new backend starts up");
        assert!(
            !lb.backends().ready(&backend(2)),
            "removed backend is not ready"
        );
        let selected = lb.select(b"", 8).map(|b| b.addr.to_string());
        assert_eq!(selected.as_deref(), Some("127.0.0.1:3"));
    }
}
