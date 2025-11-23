use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::{collections::HashMap, time::Duration};
use url::Url;

#[napi(object)]
pub struct ApplicationConfig {
    pub upstreams: Vec<String>,
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

pub struct AppUpstream {
    pub secure: bool,
    pub address: String,
}

pub struct AppDefinition {
    pub upstreams: Vec<AppUpstream>,
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

            let _upstreams = config
                .upstreams
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| {
                    let parsed = Url::parse(&value);
                    if parsed.is_err() {
                        return Err(Error::from_reason(format!(
                            "invalid URL '{value}' in upstreams for application '{name}'"
                        )));
                    }
                    let url = parsed.unwrap();
                    let secure = match url.scheme() {
                        "https" | "wss" => true,
                        "http" | "ws" => false,
                        other => {
                            return Err(Error::from_reason(format!(
                                "unsupported URL scheme '{other}' in upstream '{value}'"
                            )));
                        }
                    };
                    Ok(AppUpstream {
                        secure,
                        address: format!(
                            "{}:{}",
                            url.host_str().unwrap(),
                            url.port_or_known_default().unwrap(),
                        ),
                    })
                })
                // .filter(|value| value.is_ok())
                .collect::<Vec<_>>();

            if _upstreams.is_empty() {
                return Err(Error::from_reason(format!(
                    "application '{name}' produced no valid upstreams"
                )));
            }

            let mut upstreams = Vec::new();

            for upstream in _upstreams {
                if upstream.is_err() {
                    return Err(Error::from_reason(format!(
                        "upstream address cannot be empty in application '{name}'"
                    )));
                } else if upstream.is_ok() {
                    upstreams.push(upstream.unwrap());
                }
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
