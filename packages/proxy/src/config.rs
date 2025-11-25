use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::{collections::HashMap, time::Duration};
use url::Url;

#[napi(object)]
pub struct ApplicationUpstreamConfig {
    pub url: String,
    #[napi(ts_type = "'http' | 'websocket'")]
    pub r#type: String,
}

#[napi(object)]
pub struct ApplicationConfig {
    pub upstreams: Vec<ApplicationUpstreamConfig>,
    pub sni: Option<String>,
    pub enable_tls: Option<bool>,
}

#[napi(object)]
pub struct ProxyOptions {
    pub listen: Option<String>,
    pub tls: Option<bool>,
    pub threads: Option<u16>,
    pub health_check_interval_secs: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum UpstreamKind {
    Http,
    Websocket,
}

impl UpstreamKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Websocket => "websocket",
        }
    }
}

pub struct AppUpstream {
    pub secure: bool,
    pub address: String,
}

pub struct AppDefinition {
    pub upstreams: HashMap<UpstreamKind, Vec<AppUpstream>>,
    pub sni: Option<String>,
}

pub struct ProxyConfig {
    pub apps: HashMap<String, AppDefinition>,
    pub listen: Option<String>,
    pub threads: Option<u16>,
    pub tls: bool,
    pub health_check_interval: Option<Duration>,
}

impl ProxyConfig {
    pub fn from_inputs(
        apps: HashMap<String, ApplicationConfig>,
        options: Option<ProxyOptions>,
    ) -> Result<Self> {
        if apps.is_empty() {
            return Err(Error::from_reason(
                "apps map must contain at least one application",
            ));
        }

        let mut normalized_apps = HashMap::with_capacity(apps.len());
        for (name, config) in apps {
            if config.upstreams.is_empty() {
                return Err(Error::from_reason(format!(
                    "application '{name}' must provide at least one upstream"
                )));
            }

            let mut upstreams = HashMap::new();

            for upstream in config.upstreams {
                let trimmed = upstream.url.trim().to_string();
                if trimmed.is_empty() {
                    return Err(Error::from_reason(format!(
                        "upstream URL cannot be empty in application '{name}'"
                    )));
                }

                let parsed = Url::parse(&trimmed).map_err(|_| {
                    Error::from_reason(format!(
                        "invalid URL '{trimmed}' in upstreams for application '{name}'"
                    ))
                })?;

                let secure = match parsed.scheme() {
                    "https" | "wss" | "https+unix" | "wss+unix" => true,
                    "http" | "ws" | "http+unix" | "ws+unix" => false,
                    other => {
                        return Err(Error::from_reason(format!(
                            "unsupported URL scheme '{other}' in upstream '{trimmed}'"
                        )));
                    }
                };

                let upstream_type = match upstream.r#type.as_str() {
                    "http" => UpstreamKind::Http,
                    "websocket" => UpstreamKind::Websocket,
                    other => {
                        return Err(Error::from_reason(format!(
                            "unsupported upstream type '{other}' for application '{name}'"
                        )));
                    }
                };

                upstreams
                    .entry(upstream_type)
                    .or_insert_with(Vec::new)
                    .push(AppUpstream {
                        secure,
                        address: format!(
                            "{}:{}",
                            parsed.host_str().unwrap(),
                            parsed.port_or_known_default().unwrap(),
                        ),
                    });
            }

            if upstreams.is_empty() {
                return Err(Error::from_reason(format!(
                    "application '{name}' produced no valid upstreams"
                )));
            }

            let definition = AppDefinition {
                upstreams,
                sni: config.sni.filter(|value| !value.is_empty()),
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
            tls: options.tls.unwrap_or(false),
            health_check_interval,
        })
    }

    pub fn listener(&self) -> &str {
        self.listen.as_deref().unwrap_or("0.0.0.0:6188")
    }
}

impl Default for ProxyOptions {
    fn default() -> Self {
        Self {
            listen: None,
            threads: None,
            tls: None,
            health_check_interval_secs: Some(30),
        }
    }
}
