# Guia da Interface Web (UI) do REA

Bem-vindo ao guia de uso da interface gráfica do **REA (Reverse Engineer Anything)**. Este documento foi criado especialmente para usuários leigos ou para aqueles que preferem evitar a linha de comando para realizar análises primárias.

O REA expõe uma ferramenta poderosa via terminal (CLI) e via Agentes autônomos (MCP), mas a partir da versão atual também disponibiliza um servidor local que hospeda um painel prático pelo navegador web.

## O que é a UI do REA?

O comando `rea ui` (ou `npx rea-agents ui`) levanta um pequeno servidor web diretamente no seu computador (sem envio de dados para nuvem). Com isso, você pode abrir o seu navegador preferido e realizar análises complexas—como inspecionar um aplicativo Electron, buscar evidências num binário nativo ou analisar um pacote Android—com apenas alguns cliques.

## Como iniciar?

Certifique-se de ter o [Node.js](https://nodejs.org/pt-br) (versão 22.19, 24.11 ou 26+) instalado.

No seu terminal, digite o seguinte comando:

```bash
npx rea-agents@latest ui
```

Se você instalou globalmente:

```bash
rea ui
```

Você verá no terminal uma mensagem como:
\`\`\`text
[REA UI] Started successfully!
[REA UI] Open http://localhost:3000 in your browser.
\`\`\`

Acesse a URL `http://localhost:3000` (ou a porta informada) no navegador para ver a interface.

### Opções Avançadas

Se a porta 3000 já estiver em uso, você pode alterar a porta padrão com a flag `--port`:

```bash
rea ui --port 8080
```

## Como usar a Interface

O painel é composto de três partes principais:

1. **Menu de Comando (Command)**: Uma lista suspensa com os alvos de engenharia reversa mais comuns. Você pode escolher:
   - **Native Binary Analysis** (para binários, executáveis `.exe`, bibliotecas dinâmicas).
   - **JavaScript/Electron App** (para checar código-fonte de aplicações Desktop Node/Electron ou web).
   - **SQLite Database** (para extrair e analisar informações de bancos SQLite de aplicativos).
   - E outras opções, como `.apk` de Android (EVM e Mach-O).
2. **Caminho do Arquivo (Target Path)**: O caminho absoluto do arquivo ou pasta que você deseja que o REA inspecione (exemplo: `C:/Jogos/Jogo/app.exe` ou `/Users/Maria/Downloads/app.asar`).
3. **Botão e Resultado (Output)**: Ao clicar no botão **Run Analysis**, o motor do REA trabalhará nos bastidores em seu computador e exibirá um relatório final em formato estruturado na tela logo abaixo. Pode demorar de alguns segundos a vários minutos, dependendo do tamanho do app ou binário escolhido.

## Vantagens e Cuidados

- **Privacidade Absoluta:** O arquivo inspecionado não faz o upload para nenhum servidor. O HTML apenas coordena a execução da ferramenta já instalada na sua própria máquina.
- **Erros de Caminho:** Lembre-se sempre de copiar o **caminho absoluto** do arquivo para colar no campo de texto, pois o navegador e a CLI não saberão deduzir "arquivos na área de trabalho" a menos que você informe o caminho completo (como `/home/user/Desktop/arquivo.db`).
