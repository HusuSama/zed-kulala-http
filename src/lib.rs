use std::env;
use zed_extension_api::{self as zed, LanguageServerInstallationStatus, settings::LspSettings};

const KULALA_SERVER_NAME: &str = "kulala-ls";
const KULALA_PACKAGE_NAME: &str = "@mistweaverco/kulala-ls";
const KULALA_SERVER_PATH: &str = "node_modules/@mistweaverco/kulala-ls/cli.cjs";
const WINDOWS_BINARY_NAME: &str = "kulala-ls.cmd";
const DEFAULT_BINARY_NAME: &str = "kulala-ls";

struct KulalaHTTP {
    binary_name: String,
}

impl zed::Extension for KulalaHTTP {
    fn new() -> Self
    where
        Self: Sized,
    {
        Self {
            binary_name: DEFAULT_BINARY_NAME.to_string(),
        }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed_extension_api::LanguageServerId,
        _worktree: &zed_extension_api::Worktree,
    ) -> zed_extension_api::Result<zed_extension_api::Command> {
        let env = _worktree.shell_env();

        let (platform, _) = zed::current_platform();
        self.set_binary_name(platform);

        // Check for user-configured binary path
        if let Ok(lsp_settings) = LspSettings::for_worktree(KULALA_SERVER_NAME, _worktree)
            && let Some(binary) = lsp_settings.binary
            && let Some(path) = binary.path
        {
            let args = binary
                .arguments
                .unwrap_or_else(|| vec!["--stdio".to_string()]);
            return Ok(zed::Command {
                command: path,
                args,
                env,
            });
        }

        // Check if binary exists in PATH
        if let Some(path) = _worktree.which(&self.binary_name) {
            return Ok(zed::Command {
                command: path,
                args: vec!["--stdio".to_string()],
                env,
            });
        }

        // Install via npm and use Zed's Node runtime
        self.install_kulala_ls(_language_server_id)?;

        let node_path = zed::node_binary_path()?;
        let server_path = env::current_dir()
            .unwrap()
            .join(KULALA_SERVER_PATH)
            .to_string_lossy()
            .to_string();

        Ok(zed::Command {
            command: node_path,
            args: vec![server_path, "--stdio".to_string()],
            env,
        })
    }
}

impl KulalaHTTP {
    fn set_binary_name(&mut self, platform: zed::Os) {
        match platform {
            zed::Os::Windows => self.binary_name = WINDOWS_BINARY_NAME.to_string(),
            _ => self.binary_name = DEFAULT_BINARY_NAME.to_string(),
        }
    }

    /// Install kulala-ls via npm if not already installed or version is outdated.
    fn install_kulala_ls(
        &self,
        language_server_id: &zed::LanguageServerId,
    ) -> zed_extension_api::Result<()> {
        let latest_version = zed::npm_package_latest_version(KULALA_PACKAGE_NAME)?;
        let installed_version = zed::npm_package_installed_version(KULALA_PACKAGE_NAME)?;

        if installed_version.as_deref() != Some(latest_version.as_ref()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );

            if let Err(err) = zed::npm_install_package(KULALA_PACKAGE_NAME, &latest_version) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &LanguageServerInstallationStatus::Failed(
                        format!(
                            "Failed to download kulala-ls via npm. Please try installing it manually. Error: {}",
                            err
                        )
                        .to_string(),
                    ),
                );
                return Err(format!(
                    "Failed to install {}: {}",
                    KULALA_PACKAGE_NAME, err
                ));
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
        Ok(())
    }
}

zed::register_extension!(KulalaHTTP);
