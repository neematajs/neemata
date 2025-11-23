#![deny(clippy::all)]

use async_trait::async_trait;

use log::{error, info};
use napi::{
    Status,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use pingora::{
    prelude::*,
    server::{RunArgs, ShutdownSignal, ShutdownSignalWatch},
};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub struct LB(
    Arc<LoadBalancer<RoundRobin>>,
    Arc<ThreadsafeFunction<String, String>>,
);

#[async_trait]
impl ProxyHttp for LB {
    /// For this small example, we don't need context storage
    type CTX = ();
    fn new_ctx(&self) -> () {
        ()
    }

    async fn upstream_peer(&self, _session: &mut Session, _ctx: &mut ()) -> Result<Box<HttpPeer>> {
        let upstream = self
            .0
            .select(b"", 256) // hash doesn't matter for round robin
            .unwrap();

        // create a promise/future to receive the result from JS
        let (tx, rx) = oneshot::channel();

        self.1.call_with_return_value(
            Ok("123".to_string()),
            ThreadsafeFunctionCallMode::NonBlocking,
            |ret, _| match ret {
                Ok(value) => {
                    // println!("Received from JS: {}", value);
                    // resolve promise here
                    let _ = tx.send(value);
                    Ok(())
                }
                Err(e) => {
                    // eprintln!("Error in JS callback: {:?}", e);
                    Err(e)
                }
            },
        );

        // somehow await for the result here
        let js_answer = rx
            .await
            .map_err(|_| napi::Error::new(Status::GenericFailure, "callback dropped"));

        match js_answer {
            Ok(_) => {
                // Set SNI to one.one.one.one
                let peer = Box::new(HttpPeer::new(
                    upstream,
                    false,
                    "one.one.one.one".to_string(),
                ));
                Ok(peer)
            }
            Err(e) => {
                error!("Failed to get JS callback result: {:?}", e.reason);
                Err(Error::create(
                    ErrorType::ConnectError,
                    ErrorSource::Internal,
                    Some(ImmutStr::Static("some error from js")),
                    None,
                ))
            }
        }
    }
}

#[napi(object)]
pub struct MyProxyOptions {
    pub upstreams: Vec<String>,
    pub hostname: String,
    pub port: u16,
    pub threads: Option<u8>,
}

#[napi]
pub struct MyProxy {
    server: Option<Server>,
    shutdown_tx: Option<oneshot::Sender<ShutdownSignal>>,
    runner: Option<std::thread::JoinHandle<()>>,
}

#[napi]
impl MyProxy {
    #[napi(constructor)]
    pub fn new(
        options: MyProxyOptions,
        peer_callback: ThreadsafeFunction<String, String>,
    ) -> napi::Result<Self> {
        // print options for debugging
        info!(
            "starting proxy with upstreams={:?}, hostname={}, port={}, threads={:?}",
            options.upstreams, options.hostname, options.port, options.threads
        );

        // let mut tsfn = peer_callback.build_threadsafe_function();
        let mut my_server = Server::new(None).unwrap();

        #[cfg(unix)]
        {
            if let Some(conf) = Arc::get_mut(&mut my_server.configuration) {
                conf.threads = options.threads.unwrap_or(1) as usize;
                conf.work_stealing = false;
            }
        }

        my_server.bootstrap();

        let upstreams = LoadBalancer::try_from_iter(options.upstreams).unwrap();

        let mut lb = http_proxy_service(
            &my_server.configuration,
            LB(Arc::new(upstreams), Arc::new(peer_callback)),
        );
        lb.add_tcp(&format!("{}:{}", options.hostname, options.port));

        my_server.add_service(lb);

        Ok(Self {
            server: Some(my_server),
            shutdown_tx: None,
            runner: None,
        })
    }

    #[napi]
    pub fn run(&mut self) -> napi::Result<()> {
        if self.runner.is_some() {
            return Err(napi::Error::from_reason("server already running"));
        }

        let server = self
            .server
            .take()
            .ok_or_else(|| napi::Error::from_reason("server already running"))?;

        let (sender, receiver) = oneshot::channel();
        self.shutdown_tx = Some(sender);

        let handle = std::thread::spawn(move || {
            let mut run_args = RunArgs::default();
            #[cfg(unix)]
            {
                run_args.shutdown_signal = Box::new(JsShutdownWatch::new(receiver));
            }

            server.run(run_args);
        });

        self.runner = Some(handle);
        Ok(())
    }

    #[napi]
    pub fn shutdown(&mut self) -> napi::Result<()> {
        if let Some(sender) = self.shutdown_tx.take() {
            let _ = sender.send(ShutdownSignal::GracefulTerminate);
        }

        if let Some(handle) = self.runner.take() {
            if let Err(join_err) = handle.join() {
                return Err(napi::Error::from_reason(format!(
                    "server thread panicked: {:?}",
                    join_err
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

#[async_trait]
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
            Some(receiver) => receiver.await.unwrap_or(ShutdownSignal::FastShutdown),
            None => ShutdownSignal::FastShutdown,
        }
    }
}
