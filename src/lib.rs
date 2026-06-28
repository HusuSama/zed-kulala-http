use std::env;
use std::fs;
use std::path::PathBuf;
use zed_extension_api::{self as zed, LanguageServerInstallationStatus, settings::LspSettings};

/// Name identifying this language server in Zed (used in settings.json).
const KULALA_SERVER_NAME: &str = "kulala-ls";

/// npm package: @mistweaverco/kulala-core wraps kulala-core; postinstall
/// downloads the platform-specific kulala-core binary into the package bin/ dir.
const KULALA_CORE_PACKAGE_NAME: &str = "@mistweaverco/kulala-core";

/// Relative directory of the kulala-core binary after npm install.
const KULALA_CORE_BIN_DIR: &str = "node_modules/@mistweaverco/kulala-core/dist/bin";

/// Binary filenames for Windows vs Unix-like platforms.
const WINDOWS_BINARY_NAME: &str = "kulala-core.exe";
const DEFAULT_BINARY_NAME: &str = "kulala-core";

/// LSP relay entry point (esbuild output dist/cli.cjs, shipped with the extension).
const LSP_REPEATER_PATH: &str = "dist/cli.cjs";

const EMBEDDED_CLI_CJS: &[u8] = include_bytes!("../dist/cli.cjs");

struct KulalaHTTP;

impl zed::Extension for KulalaHTTP {
    fn new() -> Self
    where
        Self: Sized,
    {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed_extension_api::LanguageServerId,
        _worktree: &zed_extension_api::Worktree,
    ) -> zed_extension_api::Result<zed_extension_api::Command> {
        let mut env = _worktree.shell_env();

        // Inject worktree root path so the relay writes response cache into
        // .kulala-cache/response/ within the project. Must be set before the
        // user-override early return so custom binary configs also get it.
        let root_path = _worktree.root_path();
        if !root_path.is_empty() {
            env.push(("KULALA_PROJECT_ROOT".to_string(), root_path));
        }

        // Read `autoCreateTask` (default false); when true the relay appends a
        // kulala-http-request task to .zed/tasks.json on LSP startup.
        let mut auto_create_task = false;
        if let Ok(lsp_settings) = LspSettings::for_worktree(KULALA_SERVER_NAME, _worktree)
            && let Some(ref settings) = lsp_settings.settings
            && let Some(val) = settings.get("autoCreateTask")
            && let Some(b) = val.as_bool()
        {
            auto_create_task = b;
        }
        env.push((
            "KULALA_AUTO_CREATE_TASK".to_string(),
            auto_create_task.to_string(),
        ));

        // 1) User-defined binary via LspSettings takes precedence.
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

        // 2) Ensure the kulala-core binary is available.
        self.ensure_kulala_core(_language_server_id)?;

        // 3) Extract the embedded dist/cli.cjs to the work dir.
        self.ensure_repeater()?;

        // 4) Inject the kulala-core binary path via KULALA_CORE_BIN.
        let (platform, _) = zed::current_platform();
        let bin_name = match platform {
            zed::Os::Windows => WINDOWS_BINARY_NAME,
            _ => DEFAULT_BINARY_NAME,
        };
        let bin_path = env::current_dir()
            .unwrap()
            .join(KULALA_CORE_BIN_DIR)
            .join(bin_name);
        env.push((
            "KULALA_CORE_BIN".to_string(),
            bin_path.to_string_lossy().to_string(),
        ));

        // 5) Launch the LSP relay: node dist/cli.cjs --stdio
        let node_path = zed::node_binary_path()?;
        let repeater_path = env::current_dir()
            .unwrap()
            .join(LSP_REPEATER_PATH)
            .to_string_lossy()
            .to_string();

        Ok(zed::Command {
            command: node_path,
            args: vec![repeater_path, "--stdio".to_string()],
            env,
        })
    }
}

impl KulalaHTTP {
    /// Install/upgrade @mistweaverco/kulala-core via npm so the binary is available.
    fn ensure_kulala_core(
        &self,
        language_server_id: &zed::LanguageServerId,
    ) -> zed_extension_api::Result<()> {
        let latest_version = zed::npm_package_latest_version(KULALA_CORE_PACKAGE_NAME)?;
        let installed_version = zed::npm_package_installed_version(KULALA_CORE_PACKAGE_NAME)?;

        if installed_version.as_deref() != Some(latest_version.as_ref()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );

            if let Err(err) = zed::npm_install_package(KULALA_CORE_PACKAGE_NAME, &latest_version) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &LanguageServerInstallationStatus::Failed(
                        format!("Failed to install kulala-core via npm. Error: {}", err)
                            .to_string(),
                    ),
                );
                return Err(format!(
                    "Failed to install {}: {}",
                    KULALA_CORE_PACKAGE_NAME, err
                ));
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
        Ok(())
    }

    /// Extract the embedded `dist/cli.cjs` to the extension work dir.
    /// Idempotent: skips when the existing file has the same byte length, so
    /// upgrades overwrite only when cli.cjs actually changes.
    fn ensure_repeater(&self) -> zed_extension_api::Result<()> {
        let cwd: PathBuf = env::current_dir().map_err(|e| e.to_string())?;
        let target = cwd.join(LSP_REPEATER_PATH);

        if let Ok(meta) = fs::metadata(&target)
            && meta.len() as usize == EMBEDDED_CLI_CJS.len()
        {
            return Ok(());
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, EMBEDDED_CLI_CJS)
            .map_err(|e| format!("Failed to write repeater to {}: {}", target.display(), e))?;
        Ok(())
    }
}

zed::register_extension!(KulalaHTTP);
