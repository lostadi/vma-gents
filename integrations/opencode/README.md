# o-gents integration with OpenCode

Copy the `claude_vm` object from `claude_vm.example.jsonc` into the OpenCode
configuration and replace `/absolute/path/to/o-gents` with the checkout's
physical path.

`agents/vm_operator.md` is the constrained local-model operator profile. It may
call only status and the compound lifecycle or execution transactions. Its
configured model is `ollama/huihui-spark-vm:32k`, the local 32K-context alias for
`huihui-ai/Huihui-Spark-X2.5-4B-abliterated` via okenk's Q4_K_M GGUF conversion.
Run `npm run model:setup` from the repository root to download the weights and
create the alias using `Modelfile.huihui-spark-vm-32k`.

Register `huihui-spark-vm:32k` under your OpenCode Ollama provider's `models`,
with text input/output and a 32768 context limit, and copy the agent profile to
`~/.config/opencode/agents/vm_operator.md`. The Ollama provider uses
`http://127.0.0.1:11434/v1`; the MCP entry remains the local executable in the
example configuration. Restart OpenCode after changing its configuration.

The 4 GiB VM still requires the configured memory and disk headroom. Model
installation and plain chat do not establish tool-call or VM lifecycle success.
See [the setup guide](../../docs/getting-started.md) for commands and checks.
