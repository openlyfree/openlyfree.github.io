<script>
  let inputCommand = "";
  let terminalHistory = [
    { text: "ethan@portfolio:~$ cat about.txt", type: "input" },
    { text: "Professional yapper. Amateur programmer. Serial project abandoner.", type: "output" },
    { text: "Type 'help' or check 'ls projects/' to get started.", type: "output" }
  ];

  function handleKeyDown(event) {
    if (event.key === "Enter" && inputCommand.trim() !== "") {
      terminalHistory = [...terminalHistory, { text: `ethan@portfolio:~$ ${inputCommand}`, type: "input" }];

      // Basic command matching
      const cmd = inputCommand.trim().toLowerCase();
      if (cmd === "help") {
        terminalHistory = [...terminalHistory, { text: "Commands: cat about.txt, ls projects/, clear", type: "output" }];
      } else if (cmd === "ls projects/") {
        terminalHistory = [...terminalHistory, { text: "desmosinator  dappendble  lapis-mc  MergeMaterial  rebar", type: "output" }];
      } else if (cmd === "clear") {
        terminalHistory = [];
      } else {
        terminalHistory = [...terminalHistory, { text: `zsh: command not found: ${inputCommand}`, type: "output" }];
      }

      inputCommand = "";
    }
  }
</script>

<main class="crt">
  <div class="bezel">
    <div class="screen">
      <div class="screen-inner">
        <div class="output-container">
          {#each terminalHistory as line}
            <div class={line.type}>{line.text}</div>
          {/each}
        </div>

        <div class="input-line">
          <span class="prompt">ethan@portfolio:~$</span>
          <input
            type="text"
            bind:value={inputCommand}
            on:keydown={handleKeyDown}
            autofocus
            spellcheck="false"
          />
        </div>
      </div>
    </div>
  </div>
</main>
