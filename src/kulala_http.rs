use zed_extension_api::{self as zed, LanguageServerInstallationStatus, settings::LspSettings};

const KULALA_PACKAGE_NAME: &str = "@mistweaverco/kulala-ls";
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

        if let Ok(lsp_settings) = LspSettings::for_worktree("kulala-ls", _worktree) {
            if let Some(binary) = lsp_settings.binary {
                if let Some(path) = binary.path {
                    let args = binary.arguments.unwrap_or(vec!["--stdio".to_string()]);
                    return Ok(zed::Command {
                        command: path,
                        args,
                        env,
                    });
                }
            }
        }

        // If kulala-ls is not in $PATH, it will be automatically installed via npm.
        let install_result = self.install_kulala_ls(_language_server_id, _worktree);
        if !install_result {
            return Err(format!(
                "{} is not in your $PATH. Attempting to install via npm failed—please install it manually and configure this service.",
                self.binary_name
            )
            .to_string());
        }

        let path = _worktree.which(&self.binary_name).ok_or_else(|| {
            format!(
                "{} must be installed and available in $PATH.",
                self.binary_name
            )
            .to_string()
        })?;

        Ok(zed::Command {
            command: path,
            args: vec!["--stdio".to_string(), Default::default()],
            env: env,
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

    /// Install kulala-ls if it is not already installed.
    /// If kulala-ls is not in $PATH, it will be installed using npm.
    fn install_kulala_ls(
        &self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> bool {
        if let None = worktree.which(&self.binary_name) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );
            let version = if let Ok(version) = zed::npm_package_latest_version(KULALA_PACKAGE_NAME)
            {
                version
            } else {
                "".to_string()
            };
            if let Err(err) = zed::npm_install_package(KULALA_PACKAGE_NAME, &version) {
                zed::set_language_server_installation_status(
                        language_server_id,
                        &LanguageServerInstallationStatus::Failed(
                            format!("Failed to download kulala-ls via npm. Please try installing it manually. Error: {}", err)
                                .to_string(),
                        ),
                    );
                return false;
            }
        }
        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
        return true;
    }
}

zed::register_extension!(KulalaHTTP);
