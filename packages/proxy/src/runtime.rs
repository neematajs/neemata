use tokio::runtime::{Builder, Handle, Runtime};

/// Runs all of one proxy's work (traffic, health checks, and the operations behind its
/// promises) on a bounded thread pool; the addon starts no shared Tokio runtime (Pingora's
/// timeouts still use one process-wide timer thread). The proxy, its Pingora app, and pending
/// promise supervisors all hold it, so connections still draining after `stop()`, or after the
/// JS object is collected, keep running.
pub struct ProxyRuntime(Option<Runtime>);

impl ProxyRuntime {
    pub fn new(threads: usize) -> std::io::Result<Self> {
        Builder::new_multi_thread()
            .worker_threads(threads)
            .thread_name("neemata-proxy")
            .enable_all()
            .build()
            .map(|runtime| Self(Some(runtime)))
    }

    pub fn handle(&self) -> &Handle {
        self.0
            .as_ref()
            .expect("proxy runtime is only taken on drop")
            .handle()
    }
}

impl Drop for ProxyRuntime {
    fn drop(&mut self) {
        // The last reference may drop inside an async task, including one on this runtime,
        // where the blocking `Runtime` drop panics.
        if let Some(runtime) = self.0.take() {
            runtime.shutdown_background();
        }
    }
}
