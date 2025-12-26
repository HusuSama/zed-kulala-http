<div align="center">

![Kulala Logo](logo.svg)
# zed-kulala-http
An unofficial extension for Kulala, adding support for the Zed editor. Visit the [Kulala repository](https://github.com/mistweaverco/kulala.nvim) to unlock a whole new world!

</div>

## Features

- Syntax highlighting
- Auto-completion
- Send requests using `kulala_cli` or `httpyac`.

## Installation

> [!important]
> The extension will automatically download the `kulala-ls` service via npm, but this may fail in some cases. You can manually install it using the command below:
>
> ```bash
> npm install -g @mistweaverco/kulala-ls
> ```

- Install `nodejs` and ensure that `npm` works properly.
- In the `Zed` editor, install the `Kulala HTTP` extension.


## Usage

- LSP

In most cases, you don't need to configure anything and can start using it right away. If the executable isn't found, you can specify its path in your settings.json file.

```json
"lsp": {
  "kulala-ls": {
    "binary": {
      "path": "D:\\nodejs\\kulala-ls.cmd",  // Replace it with your own path.
      "arguments": ["--stdio"],
    }
  },
}
```

- Formatting

To format HTTP files, you need to install kulala-fmt. Install it using the command below:

```bash
npm install -g @mistweaverco/kulala-fmt
```

In your `settings.json` file, add the following configuration. Note that you need to update the command path to match your local setup:

```json
"languages": {
  "kulala-http": {
    "formatter": {
      "external": {
        "command": "D:\\nodejs\\kulala-fmt.cmd",
        "arguments": ["format", "--stdin", "{buffer_path}"],
      },
    },
    "format_on_save": "on",
  },
},
```

- Request

To send HTTP requests, you need to use either `httpyac` or `kulala_cli`. Currently, `kulala_cli` is only supported when `Neovim (nvim)` is installed. A standalone version of `kulala_cli` is under development. If you already have Neovim, we recommend using `kulala_cli` for better compatibility.

Download httpyac: https://github.com/AnWeber/httpyac
Download kulala_cli [Coming soon.]: https://github.com/mistweaverco/kulala-cli

If you have Neovim installed and are using `kulala.nvim`, you can find the CLI script at `kulala.nvim/lua/cli/kulala_cli.lua`. You can place this file (or a symlink to it) in your `$PATH` for convenient access.

You need to create a task to perform the request operation.

```json
{
  "label": "Run HTTP Request",
  "command": "httpyac",
  "args": ["send", "--line", "$ZED_ROW", "$ZED_FILE"],
  "tags": ["http-request"],
  "reveal": "always",
},
```

Binding it to a keyboard shortcut is also a great idea.

```json
"space R s": [
  "task::Spawn",
  { "task_name": "Run HTTP Request", "reveal_target": "center" },
],
```

## Special thanks

**kulala.nvim**

`kulala.nvim` is an exceptionally well-crafted plugin that offers seamless compatibility with the `IntelliJ HTTP Client`. It’s thanks to this outstanding project that the development of `zed-kulala-http` has been possible. The `Tree-sitter` grammar and `LSP` server used in this project are both derived from `kulala.nvim`. Our goal is to bring the same excellent development experience that kulala provides in Neovim to the Zed editor as well. Please support `kulala.nvim`! ❤️
