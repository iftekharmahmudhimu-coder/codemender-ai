const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

export function createLogger({ level = "info", color = process.stdout.isTTY } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const paint = (c, s) => (color ? `${COLORS[c]}${s}${COLORS.reset}` : s);
  const stamp = () => paint("dim", new Date().toISOString().slice(11, 19));

  const out = (lvl, colorName, prefix, args) => {
    if (LEVELS[lvl] > threshold) return;
    const line = `${stamp()} ${paint(colorName, prefix)} ${args.join(" ")}`;
    (lvl === "error" ? process.stderr : process.stdout).write(line + "\n");
  };

  return {
    level,
    error: (...a) => out("error", "red", "ERR ", a),
    warn: (...a) => out("warn", "yellow", "WARN", a),
    info: (...a) => out("info", "cyan", "INFO", a),
    success: (...a) => out("info", "green", " OK ", a),
    step: (...a) => out("info", "magenta", "STEP", a),
    debug: (...a) => out("debug", "dim", "DBG ", a),
    raw: (s) => process.stdout.write(s),
  };
}
