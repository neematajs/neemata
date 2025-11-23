use crate::{
    config::{ApplicationConfig, ProxyConfig, ProxyOptions},
    router::{RouterAssembly, build_router},
};
use log::{debug, info};
use napi::Error as NapiError;
use napi_derive::napi;
use pingora::{
    prelude::{Opt, Server, http_proxy_service},
    server::{RunArgs, ShutdownSignal, ShutdownSignalWatch, configuration::ServerConf},
};
use std::{collections::HashMap, sync::Mutex, thread};
use tokio::sync::oneshot;

#[napi]
pub struct NeemataProxy {
    server: Option<Server>,
    shutdown_tx: Option<oneshot::Sender<ShutdownSignal>>,
    runner: Option<thread::JoinHandle<()>>,
}

#[napi]
impl NeemataProxy {
    #[napi(constructor)]
    pub fn new(
        apps: HashMap<String, ApplicationConfig>,
        options: Option<ProxyOptions>,
    ) -> napi::Result<Self> {
        env_logger::try_init().ok();
        const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS: u64 = 1;
        let config = ProxyConfig::from_inputs(apps, options)?;

        let mut server_conf = ServerConf::default();
        let mut server_opts = Opt::default();

        server_opts.daemon = false;
        server_conf.grace_period_seconds = Some(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS - 1);
        server_conf.graceful_shutdown_timeout_seconds =
            Some(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS);
        server_conf.threads = config.threads.unwrap_or(1) as usize;
        server_conf.work_stealing = false;

        let mut server = Server::new_with_opt_and_conf(server_opts, server_conf);

        let RouterAssembly {
            router,
            background_services,
        } = build_router(&config)?;

        let mut proxy_service = http_proxy_service(&server.configuration, router);

        if config.tls {
            // TODO: support TLS options
        } else {
            proxy_service.add_tcp(config.listener());
        }

        server.add_service(proxy_service);

        for service in background_services {
            server.add_service(service);
        }

        Ok(Self {
            server: Some(server),
            shutdown_tx: None,
            runner: None,
        })
    }

    #[napi]
    pub fn run(&mut self) -> napi::Result<()> {
        if self.runner.is_some() {
            return Err(NapiError::from_reason("server already running"));
        }

        let server = self
            .server
            .take()
            .ok_or_else(|| NapiError::from_reason("server already running"))?;

        let (tx, rx) = oneshot::channel();
        self.shutdown_tx = Some(tx);

        let handle = thread::spawn(move || {
            let mut args = RunArgs::default();
            args.shutdown_signal = Box::new(JsShutdownWatch::new(rx));
            server.run(args);
        });

        self.runner = Some(handle);
        Ok(())
    }

    #[napi]
    pub fn shutdown(&mut self) -> napi::Result<()> {
        info!("Shutting down server. Sending shutdown signal...");
        let tx = self.shutdown_tx.take().unwrap();
        let _ = tx.send(ShutdownSignal::GracefulTerminate);

        info!("Joining server thread...");
        let handle = self.runner.take().unwrap();
        let _ = handle.join();
        info!("Server shut down successfully.");
        Ok(())
    }
}

struct JsShutdownWatch {
    receiver: Mutex<Option<oneshot::Receiver<ShutdownSignal>>>,
}

impl JsShutdownWatch {
    fn new(receiver: oneshot::Receiver<ShutdownSignal>) -> Self {
        Self {
            receiver: Mutex::new(Some(receiver)),
        }
    }
}

#[async_trait::async_trait]
impl ShutdownSignalWatch for JsShutdownWatch {
    async fn recv(&self) -> ShutdownSignal {
        let receiver = {
            let mut guard = match self.receiver.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };

            guard.take()
        };

        match receiver {
            Some(rx) => {
                debug!("Waiting for shutdown signal from JS...");
                let signal = rx.await.unwrap_or(ShutdownSignal::FastShutdown);
                info!("Received shutdown signal from JS: {:?}", signal);
                signal
            }
            None => ShutdownSignal::FastShutdown,
        }
    }
}
