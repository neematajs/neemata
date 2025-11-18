use crate::{
    config::{ApplicationConfig, GatewayConfig, GatewayOptions},
    router::{build_router, RouterAssembly},
};
use napi::Error as NapiError;
use napi_derive::napi;
use pingora::{
    prelude::{http_proxy_service, Server},
    server::{RunArgs, ShutdownSignal, ShutdownSignalWatch},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    thread,
};
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
        options: Option<GatewayOptions>,
    ) -> napi::Result<Self> {
        let config = GatewayConfig::from_inputs(apps, options)?;

        let mut server = Server::new(None).map_err(|err| {
            NapiError::from_reason(format!("failed to create pingora server: {err:?}"))
        })?;

        #[cfg(unix)]
        if let Some(conf) = Arc::get_mut(&mut server.configuration) {
            if let Some(threads) = config.threads {
                conf.threads = threads as usize;
            }
            conf.work_stealing = false;
        }

        server.bootstrap();

        let RouterAssembly {
            router,
            background_services,
        } = build_router(&config)?;

        let mut proxy_service = http_proxy_service(&server.configuration, router);
        proxy_service.add_tcp(config.listener());
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
            #[cfg(unix)]
            {
                args.shutdown_signal = Box::new(JsShutdownWatch::new(rx));
            }
            server.run(args);
        });

        self.runner = Some(handle);
        Ok(())
    }

    #[napi]
    pub fn shutdown(&mut self) -> napi::Result<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(ShutdownSignal::GracefulTerminate);
        }

        if let Some(handle) = self.runner.take() {
            if let Err(err) = handle.join() {
                return Err(NapiError::from_reason(format!(
                    "server thread panicked: {err:?}"
                )));
            }
        }

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
            Some(rx) => rx.await.unwrap_or(ShutdownSignal::FastShutdown),
            None => ShutdownSignal::FastShutdown,
        }
    }
}
