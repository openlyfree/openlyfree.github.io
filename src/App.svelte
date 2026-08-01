<script lang="ts">
  import { onMount } from "svelte";
  import { WebContainer } from "@webcontainer/api";
  import type { FileSystemTree, WebContainerProcess } from "@webcontainer/api";
  import * as THREE from "three";

  type TerminalLine = {
    text: string;
    type: "input" | "output";
  };

  type GitHubRepo = {
    name: string;
    default_branch: string;
    description: string | null;
    html_url: string;
    homepage: string | null;
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    updated_at: string;
    archived: boolean;
    fork: boolean;
  };

  let homeDirectory = "/workspace";
  const githubUsername = "openlyfree";
  const knownCommands = [
    "ls",
    "cat",
    "cd",
    "pwd",
    "clear",
    "echo",
    "mkdir",
    "touch",
    "rm",
    "cp",
    "mv",
    "head",
    "tail",
    "grep",
    "wc"
  ];

  let inputCommand = "";
  let currentDirectory = homeDirectory;
  let terminalHistory: TerminalLine[] = [
    { text: "Booting terminal…", type: "output" },
    { text: `ethan@webcontainer:${currentDirectory}$ cat about.txt`, type: "input" },
    { text: "Professional yapper. Amateur programmer. Serial project abandoner.", type: "output" },
    { text: "Type 'help' or check 'ls projects/' to get started.", type: "output" }
  ];
  let webContainer: WebContainer | null = null;
  let webContainerReady = false;
  let commandRunning = false;
  let projectNames: string[] = [];

  let crtCanvas: HTMLCanvasElement | null = null;
  let offscreenCanvas: HTMLCanvasElement | null = null;
  let offscreenContext: CanvasRenderingContext2D | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let animationFrameId = 0;
  let blinkIntervalId = 0;
  let terminalScrollOffset = 0;
  let dirty = true;
  let caretVisible = true;

  const shaderUniforms = {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexture: { value: null as THREE.Texture | null }
  };

  function getPrompt() {
    const displayDirectory = currentDirectory === homeDirectory ? "~" : currentDirectory;
    return `[anonymous@openlyfree ${displayDirectory}]$`;
  }

  function shellEscape(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function normalizeAbsolutePath(path: string) {
    const parts = path.split("/").filter(Boolean);
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === ".") {
        continue;
      }
      if (part === "..") {
        normalized.pop();
        continue;
      }
      normalized.push(part);
    }
    return `/${normalized.join("/")}`;
  }

  function resolvePath(inputPath: string) {
    if (inputPath === "~" || inputPath.startsWith("~/")) {
      const suffix = inputPath.slice(1);
      return normalizeAbsolutePath(`${homeDirectory}${suffix}`);
    }
    if (inputPath.startsWith("/")) {
      return normalizeAbsolutePath(inputPath);
    }
    return normalizeAbsolutePath(`${currentDirectory}/${inputPath}`);
  }

  async function isDirectory(path: string) {
    const projectRoot = normalizeAbsolutePath(`${homeDirectory}/projects`);
    if (path === projectRoot) {
      return true;
    }
    if (path.startsWith(`${projectRoot}/`)) {
      const [repoName] = path.slice(projectRoot.length + 1).split("/");
      if (projectNames.includes(repoName)) {
        return true;
      }
    }
    if (!webContainer) {
      return false;
    }
    try {
      await webContainer.fs.readdir(path);
      return true;
    } catch {
      return false;
    }
  }

  function longestCommonPrefix(values: string[]) {
    if (values.length === 0) {
      return "";
    }
    let prefix = values[0];
    for (const value of values.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < value.length && prefix[i] === value[i]) {
        i++;
      }
      prefix = prefix.slice(0, i);
      if (prefix === "") {
        break;
      }
    }
    return prefix;
  }

  function pushOutput(text: string) {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const entries = lines.map((line) => ({ text: line, type: "output" as const }));
    terminalHistory = [...terminalHistory, ...entries];
    terminalScrollOffset = 0;
    dirty = true;
  }

  async function fetchAllPublicRepos(username: string) {
    const perPage = 100;
    const repos: GitHubRepo[] = [];

    for (let page = 1; ; page++) {
      const response = await fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc&visibility=public`
      );

      if (!response.ok) {
        throw new Error(`GitHub API request failed with status ${response.status}.`);
      }

      const pageRepos = (await response.json()) as GitHubRepo[];
      repos.push(...pageRepos.filter((repo) => !repo.archived).sort((a, b) => a.name.localeCompare(b.name)));

      if (pageRepos.length < perPage) {
        break;
      }
    }

    return repos.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function fetchRepoReadme(username: string, repo: GitHubRepo) {
    const candidates = [
      `https://raw.githubusercontent.com/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/${encodeURIComponent(repo.default_branch)}/README.md`,
      `https://raw.githubusercontent.com/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/${encodeURIComponent(repo.default_branch)}/README`,
      `https://raw.githubusercontent.com/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/${encodeURIComponent(repo.default_branch)}/readme.md`,
      `https://raw.githubusercontent.com/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/${encodeURIComponent(repo.default_branch)}/README.MD`
    ];

    for (const url of candidates) {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      if (response.status !== 404) {
        break;
      }
    }

    return null;
  }

  async function buildRepoFileTree(repos: GitHubRepo[]): Promise<FileSystemTree> {
    const directory: FileSystemTree = {};
    const readmes = await Promise.all(
      repos.map(async (repo) => {
        try {
          return {
            name: repo.name,
            readme: await fetchRepoReadme(githubUsername, repo)
          };
        } catch {
          return {
            name: repo.name,
            readme: null
          };
        }
      })
    );

    for (const repo of repos) {
      const readme = readmes.find((entry) => entry.name === repo.name)?.readme;
      const contents =
        readme ??
        [
          `# ${repo.name}`,
          "",
          repo.description ?? "No description provided.",
          "",
          `Repository: ${repo.html_url}`
        ].join("\n");

      directory[repo.name] = {
        directory: {
          "project.md": {
            file: {
              contents
            }
          }
        }
      };
    }

    return { directory };
  }

  function buildFallbackProjectTree(): FileSystemTree {
    return {
      directory: {
        desmosinator: { directory: { "project.md": { file: { contents: "A graphing side project." } } } },
        dappendble: { directory: { "project.md": { file: { contents: "A tiny app experiment." } } } },
        "lapis-mc": { directory: { "project.md": { file: { contents: "Minecraft-related tooling project." } } } },
        MergeMaterial: { directory: { "project.md": { file: { contents: "A material/merge utility prototype." } } } },
        rebar: { directory: { "project.md": { file: { contents: "Another side project in progress." } } } }
      }
    };
  }

  async function spawnCommand(command: string): Promise<WebContainerProcess> {
    if (!webContainer) {
      throw new Error("WebContainer is unavailable.");
    }

    try {
      return await webContainer.spawn("jsh", ["-c", command]);
    } catch {
      return await webContainer.spawn("sh", ["-c", command]);
    }
  }

  async function executeCommand() {
    if (inputCommand.trim() === "") {
      return;
    }

    const command = inputCommand.trim();
    terminalHistory = [...terminalHistory, { text: `${getPrompt()} ${command}`, type: "input" }];
    inputCommand = "";
    terminalScrollOffset = 0;
    dirty = true;

    if (command === "clear") {
      terminalHistory = [];
      dirty = true;
      return;
    }

    if (command === "help") {
      pushOutput("Try: ls, pwd, cat about.txt, cd projects, clear. Then cd into a repo and cat project.md. Press Tab for completion.");
      return;
    }

    if (!webContainerReady) {
      pushOutput("WebContainer is still booting. Try again in a moment.");
      return;
    }

    if (commandRunning) {
      pushOutput("A command is already running.");
      return;
    }

    commandRunning = true;

    try {
      if (command === "cd" || command.startsWith("cd ")) {
        const cdMatch = command.match(/^cd(?:\s+(.+?))?(?:\s*(?:&&|;)\s*(.+))?$/);
        const destinationArg = cdMatch?.[1]?.trim() ?? "";
        const chainedCommand = cdMatch?.[2]?.trim() ?? "";
        const destination = destinationArg === "" || destinationArg === "~" ? homeDirectory : resolvePath(destinationArg);
        const existsAsDirectory = await isDirectory(destination);
        if (!existsAsDirectory) {
          pushOutput(`cd: no such file or directory: ${destinationArg || "~"}`);
          return;
        }
        currentDirectory = destination;
        dirty = true;

        if (chainedCommand !== "") {
          const process = await spawnCommand(`cd ${shellEscape(currentDirectory)} && ${chainedCommand}`);
          let buffer = "";

          const outputDone = process.output.pipeTo(
            new WritableStream({
              write(chunk) {
                const merged = `${buffer}${chunk}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                const parts = merged.split("\n");
                buffer = parts.pop() ?? "";
                for (const line of parts) {
                  terminalHistory = [...terminalHistory, { text: line, type: "output" }];
                }
                dirty = true;
              }
            })
          );

          const exitCode = await process.exit;
          await outputDone;

          if (buffer.length > 0) {
            terminalHistory = [...terminalHistory, { text: buffer, type: "output" }];
          }
          if (exitCode !== 0) {
            terminalHistory = [...terminalHistory, { text: `[exit ${exitCode}]`, type: "output" }];
          }
          dirty = true;
        }
        return;
      }

      const process = await spawnCommand(`cd ${shellEscape(currentDirectory)} && ${command}`);
      let buffer = "";

      const outputDone = process.output.pipeTo(
        new WritableStream({
          write(chunk) {
            const merged = `${buffer}${chunk}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const parts = merged.split("\n");
            buffer = parts.pop() ?? "";
            for (const line of parts) {
              terminalHistory = [...terminalHistory, { text: line, type: "output" }];
            }
            dirty = true;
          }
        })
      );

      const exitCode = await process.exit;
      await outputDone;

      if (buffer.length > 0) {
        terminalHistory = [...terminalHistory, { text: buffer, type: "output" }];
      }
      if (exitCode !== 0) {
        terminalHistory = [...terminalHistory, { text: `[exit ${exitCode}]`, type: "output" }];
      }
      dirty = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown command failure";
      pushOutput(`Command failed: ${message}`);
    } finally {
      commandRunning = false;
    }
  }

  async function completeInput() {
    if (!webContainerReady || commandRunning) {
      return;
    }

    const trimmedLeft = inputCommand.trimStart();
    const hasWhitespace = trimmedLeft.includes(" ");

    if (!hasWhitespace) {
      const matches = knownCommands.filter((cmd) => cmd.startsWith(trimmedLeft));
      if (matches.length === 1) {
        inputCommand = matches[0];
      } else if (matches.length > 1) {
        const prefix = longestCommonPrefix(matches);
        inputCommand = prefix;
        terminalHistory = [...terminalHistory, { text: `${getPrompt()} ${inputCommand}`, type: "input" }];
        pushOutput(matches.join("  "));
      }
      dirty = true;
      return;
    }

    if (!webContainer) {
      return;
    }

    const endsWithSpace = /\s$/.test(inputCommand);
    const tokens = inputCommand.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return;
    }
    const command = tokens[0];
    if (!["cd", "ls", "cat"].includes(command)) {
      return;
    }

    const targetToken = endsWithSpace ? "" : tokens[tokens.length - 1];
    const slashIndex = targetToken.lastIndexOf("/");
    const tokenBase = slashIndex >= 0 ? targetToken.slice(0, slashIndex + 1) : "";
    const tokenPartial = slashIndex >= 0 ? targetToken.slice(slashIndex + 1) : targetToken;
    const lookupBase = tokenBase === "" ? "." : tokenBase;
    const lookupPath = resolvePath(lookupBase);

    let entries: string[];
    try {
      entries = await webContainer.fs.readdir(lookupPath);
    } catch {
      return;
    }

    const matchingEntries = entries.filter((entry) => entry.startsWith(tokenPartial)).sort();
    if (matchingEntries.length === 0) {
      return;
    }

    const decoratedEntries: string[] = [];
    for (const entry of matchingEntries) {
      const entryPath = normalizeAbsolutePath(`${lookupPath}/${entry}`);
      const suffix = (await isDirectory(entryPath)) ? "/" : "";
      decoratedEntries.push(`${entry}${suffix}`);
    }

    const common = longestCommonPrefix(decoratedEntries);
    if (matchingEntries.length === 1) {
      const replacement = `${tokenBase}${decoratedEntries[0]}`;
      inputCommand = endsWithSpace ? `${inputCommand}${replacement}` : `${inputCommand.slice(0, inputCommand.length - targetToken.length)}${replacement}`;
      dirty = true;
      return;
    }

    if (common.length > tokenPartial.length) {
      const replacement = `${tokenBase}${common}`;
      inputCommand = endsWithSpace ? `${inputCommand}${replacement}` : `${inputCommand.slice(0, inputCommand.length - targetToken.length)}${replacement}`;
    }
    terminalHistory = [...terminalHistory, { text: `${getPrompt()} ${inputCommand}`, type: "input" }];
    pushOutput(decoratedEntries.join("  "));
    dirty = true;
  }

  function handleTerminalInput(event: KeyboardEvent) {
    const ignoredMetaKey = event.ctrlKey || event.altKey || event.metaKey;
    if (ignoredMetaKey) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void executeCommand();
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      inputCommand = inputCommand.slice(0, -1);
      dirty = true;
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      void completeInput();
      return;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      inputCommand += event.key;
      dirty = true;
    }
  }

  function wrapTerminalLine(text: string, maxCharsPerLine: number) {
    if (text.length <= maxCharsPerLine) {
      return [text];
    }

    const wrapped: string[] = [];
    let current = text;
    while (current.length > maxCharsPerLine) {
      wrapped.push(current.slice(0, maxCharsPerLine));
      current = current.slice(maxCharsPerLine);
    }
    if (current.length > 0) {
      wrapped.push(current);
    }
    return wrapped;
  }

  function redrawTerminalTexture() {
    if (!offscreenCanvas || !offscreenContext) {
      return;
    }

    const ctx = offscreenContext;
    const width = offscreenCanvas.width;
    const height = offscreenCanvas.height;
    const fontSize = 20;
    const lineHeight = 30;
    const padding = 30;
    const maxChars = 120;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#071507";
    ctx.fillRect(0, 0, width, height);

    ctx.font = `${fontSize}px "Fira Code", "JetBrains Mono", Menlo, Monaco, Consolas, monospace`;
    ctx.textBaseline = "top";
    ctx.shadowBlur = 16;
    ctx.shadowColor = "rgba(57, 211, 83, 0.62)";

    const renderedLines: TerminalLine[] = [];
    for (const line of terminalHistory) {
      const wrapped = wrapTerminalLine(line.text, maxChars);
      for (const segment of wrapped) {
        renderedLines.push({ text: segment, type: line.type });
      }
    }

    const inputLine = `${getPrompt()} ${inputCommand}${caretVisible ? "█" : " "}`;
    for (const segment of wrapTerminalLine(inputLine, maxChars)) {
      renderedLines.push({ text: segment, type: "input" });
    }

    const maxRows = Math.floor((height - padding * 2) / lineHeight);
    const maxScroll = Math.max(0, renderedLines.length - maxRows);
    terminalScrollOffset = Math.max(0, Math.min(terminalScrollOffset, maxScroll));
    const scrollRows = Math.round(terminalScrollOffset);
    const startIndex = Math.max(0, renderedLines.length - maxRows - scrollRows);
    const visible = renderedLines.slice(startIndex, startIndex + maxRows);

    let y = padding;
    for (const line of visible) {
      ctx.fillStyle = line.type === "input" ? "#39d353" : "#2ea043";
      ctx.fillText(line.text, padding, y);
      y += lineHeight;
    }

    const texture = shaderUniforms.uTexture.value;
    if (texture) {
      texture.needsUpdate = true;
    }
    dirty = false;
  }

  function createShaderMaterial(texture: THREE.Texture) {
    return new THREE.ShaderMaterial({
      uniforms: shaderUniforms,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        uniform vec2 uResolution;
        uniform float uTime;

        vec2 barrel(vec2 uv, float k) {
          vec2 p = uv * 2.0 - 1.0;
          float r2 = dot(p, p);
          p *= 1.0 + k * r2;
          return p * 0.5 + 0.5;
        }

        float rand(vec2 co) {
          return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec2 curvedUv = barrel(vUv, 0.1);

          if (curvedUv.x < 0.0 || curvedUv.x > 1.0 || curvedUv.y < 0.0 || curvedUv.y > 1.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec2 aberration = vec2(1.8 / uResolution.x, 0.0);
          float r = texture2D(uTexture, curvedUv + aberration).r;
          float g = texture2D(uTexture, curvedUv).g;
          float b = texture2D(uTexture, curvedUv - aberration).b;
          vec3 color = vec3(r, g, b);

          float scanline = 0.9 + 0.1 * sin(curvedUv.y * uResolution.y * 1.15);
          color *= scanline;

          float grille = 0.95 + 0.05 * sin(curvedUv.x * uResolution.x * 0.33);
          color *= grille;

          float vignette = smoothstep(1.05, 0.18, distance(vUv, vec2(0.5)));
          color *= vignette;

          float staticNoise = (rand(vUv + uTime * 0.015) - 0.5) * 0.08;
          color += staticNoise;

          float flicker = 0.985 + 0.015 * sin(uTime * 18.0);
          color *= flicker;

          gl_FragColor = vec4(color, 1.0);
        }
      `
    });
  }

  async function bootWebContainer() {
    try {
      pushOutput("Booting StackBlitz WebContainer…");
      let projectsTree = buildFallbackProjectTree();
      let loadedRepoCount = 0;

      try {
        const repos = await fetchAllPublicRepos(githubUsername);
        projectNames = repos.map((repo) => repo.name);
        projectsTree = await buildRepoFileTree(repos);
        loadedRepoCount = repos.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load public GitHub repos.";
        pushOutput(`GitHub repo load failed: ${message}`);
        projectNames = ["desmosinator", "dappendble", "lapis-mc", "MergeMaterial", "rebar"];
      }

      const files: FileSystemTree = {
        "about.txt": {
          file: {
            contents: "Professional yapper. Amateur programmer. Serial project abandoner."
          }
        },
        projects: projectsTree
      };

      webContainer = await WebContainer.boot();
      await webContainer.mount(files);
      homeDirectory = webContainer.workdir;
      currentDirectory = homeDirectory;
      webContainerReady = true;
      if (loadedRepoCount > 0) {
        pushOutput(`Loaded ${loadedRepoCount} public GitHub repos.`);
      }
      pushOutput("WebContainer ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebContainer failed to boot.";
      pushOutput(`WebContainer error: ${message}`);
    }
  }

  onMount(() => {
    if (!crtCanvas) {
      return;
    }

    offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = 1600;
    offscreenCanvas.height = 1000;
    offscreenContext = offscreenCanvas.getContext("2d");

    if (!offscreenContext) {
      return;
    }

    const texture = new THREE.CanvasTexture(offscreenCanvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    shaderUniforms.uTexture.value = texture;

    renderer = new THREE.WebGLRenderer({
      canvas: crtCanvas,
      antialias: true,
      powerPreference: "high-performance"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = createShaderMaterial(texture);
    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    const resize = () => {
      if (!crtCanvas || !renderer) {
        return;
      }

      const width = crtCanvas.clientWidth;
      const height = crtCanvas.clientHeight;
      renderer.setSize(width, height, false);
      shaderUniforms.uResolution.value.set(width, height);
      dirty = true;
    };

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(crtCanvas);
    resize();

    const startTime = performance.now();
    const render = () => {
      animationFrameId = requestAnimationFrame(render);
      shaderUniforms.uTime.value = (performance.now() - startTime) / 1000;

      if (dirty) {
        redrawTerminalTexture();
      }

      renderer?.render(scene, camera);
    };
    render();

    blinkIntervalId = window.setInterval(() => {
      caretVisible = !caretVisible;
      dirty = true;
    }, 470);

    const handleTerminalWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        return;
      }

      event.preventDefault();
      terminalScrollOffset = Math.max(0, terminalScrollOffset + event.deltaY / 24);
      dirty = true;
    };

    window.addEventListener("keydown", handleTerminalInput);
    window.addEventListener("wheel", handleTerminalWheel, { passive: false });
    void bootWebContainer();

    return () => {
      window.removeEventListener("keydown", handleTerminalInput);
      window.removeEventListener("wheel", handleTerminalWheel);
      window.clearInterval(blinkIntervalId);
      cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      webContainer?.teardown();
      renderer?.dispose();
      offscreenCanvas = null;
      offscreenContext = null;
      renderer = null;
    };
  });
</script>

<main class="crt-screen">
  <canvas bind:this={crtCanvas} aria-label="Retro CRT terminal portfolio"></canvas>
</main>
