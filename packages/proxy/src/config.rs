use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::{
    collections::HashMap,
    time::Duration,
};

#[napi(object)]
pub struct ApplicationConfig {
    pub upstreams: Vec<String>,
    pub sni: Option<String>,
    pub enable_tls: Option<bool>,
}

#[napi(object)]
pub struct GatewayOptions {
    pub listen: Option<String>,
    pub threads: Option<u16>,
    pub health_check_interval_secs: Option<u32>,
}

pub struct AppDefinition {
    pub upstreams: Vec<String>,
    pub sni: Option<String>,
    pub enable_tls: bool,
}

pub struct GatewayConfig {
    pub apps: HashMap<String, AppDefinition>,
    pub listen: Option<String>,
    pub threads: Option<u16>,
    pub health_check_interval: Option<Duration>,
}

impl GatewayConfig {
    pub fn from_inputs(
        apps: HashMap<String, ApplicationConfig>,
        options: Option<GatewayOptions>,
    ) -> Result<Self> {
        if apps.is_empty() {
            return Err(Error::from_reason("apps map must contain at least one application"));
        }

        let mut normalized_apps = HashMap::with_capacity(apps.len());
        for (name, config) in apps {
            if config.upstreams.is_empty() {
                return Err(Error::from_reason(format!(
                    "application '{name}' must provide at least one upstream"
                )));
            }

            let upstreams = config
                .upstreams
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();

            if upstreams.is_empty() {
                return Err(Error::from_reason(format!(
                    "application '{name}' produced no valid upstreams"
                )));
            }

            let definition = AppDefinition {
                upstreams,
                sni: config.sni.filter(|value| !value.is_empty()),
                enable_tls: config.enable_tls.unwrap_or(false),
            };

            normalized_apps.insert(name, definition);
        }

        let options = options.unwrap_or_default();

        let health_check_interval = options
            .health_check_interval_secs
            .map(|secs| Duration::from_secs(secs as u64));

        Ok(Self {
            apps: normalized_apps,
            listen: options.listen,
            threads: options.threads,
            health_check_interval,
        })
    }

    pub fn listener(&self) -> &str {
        self.listen.as_deref().unwrap_or("0.0.0.0:6188")
    }
}

impl Default for GatewayOptions {
    fn default() -> Self {
        Self {
            listen: None,
            threads: None,
            health_check_interval_secs: Some(30),
        }
    }
}
