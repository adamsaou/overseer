#!/bin/sh
# Overseer installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/adamsaou/overseer/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/adamsaou/overseer/main/install.sh | sh -s -- --prefix "$HOME/.local"
#
# Installs the @adamsaou/overseer npm package. It never runs sudo and never changes your npm config or
# your shell files: when npm's global folder isn't writable by you, it installs for your user only with a
# one-off --prefix flag and says so.
#
# The whole script is one { ... } block that ends on the last line, so the shell reads all of it before
# running anything, and a partly downloaded script is a syntax error that does nothing.
{
set -eu

NAME=@adamsaou/overseer
MIN_NODE_MAJOR=22

say() { printf '%s\n' "$*"; }
warn() { printf 'overseer install: warning: %s\n' "$*" >&2; }
die() {
  printf 'overseer install: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--prefix DIR] [--package SPEC]

  --prefix DIR    Install into DIR/lib/node_modules and link DIR/bin/overseer.
                  Default: npm's global folder if you can write to it, otherwise ~/.local.
  --package SPEC  What to install: an npm spec such as @adamsaou/overseer@0.1.0, or a local
                  .tgz made by npm pack, for testing. Default: @adamsaou/overseer.
EOF
}

# True when $1 is a writable directory, or does not exist yet and its nearest existing parent is.
can_write() {
  dir=$1
  while [ ! -e "$dir" ]; do dir=$(dirname "$dir"); done
  [ -d "$dir" ] && [ -w "$dir" ]
}

# npm 12 masks UUID-like text in its output (`npm prefix -g` can print ***), so read the global
# prefix from npm's script environment, which a child process prints unmasked.
npm_global_prefix() {
  # shellcheck disable=SC2016 # expanded by the shell npm starts, not here
  p=$(npm exec --yes=false -c 'printf "%s" "$npm_config_global_prefix"' 2>/dev/null) || p=
  [ -n "$p" ] || p=$(npm prefix --global)
  printf '%s\n' "$p"
}

on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# A Dockerfile RUN step or a cron job may have no SHELL at all.
path_hint() {
  shell=${SHELL:-}
  case ${shell##*/} in
    fish) say "    fish_add_path $1" ;;
    zsh) say "    echo 'export PATH=\"$1:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
    bash) say "    echo 'export PATH=\"$1:\$PATH\"' >> ~/.bashrc && exec bash" ;;
    *) say "    Add $1 to PATH in your shell's startup file, then open a new terminal." ;;
  esac
}

# npm won't replace a bin/overseer that it didn't install there (EEXIST), so say why before it fails.
# npm's own link points into the package: ../lib/node_modules/@adamsaou/overseer/...
check_bin() {
  bin=$1/bin/overseer
  [ -e "$bin" ] || [ -L "$bin" ] || return 0
  if [ -L "$bin" ]; then
    target=$(readlink "$bin" 2>/dev/null) || target=
    case $target in
      "$1/lib/node_modules/$NAME"/* | "../lib/node_modules/$NAME"/*) return 0 ;;
    esac
    die "$bin already exists and isn't from this package (it points to ${target:-somewhere unreadable}).
Remove it, or install somewhere else with --prefix DIR."
  fi
  die "$bin already exists and isn't from this package. Remove it, or install somewhere else with --prefix DIR."
}

main() {
  prefix=${OVERSEER_PREFIX:-}
  package=${OVERSEER_PACKAGE:-$NAME}
  while [ $# -gt 0 ]; do
    case $1 in
      --prefix)
        [ $# -ge 2 ] || die "--prefix needs a directory"
        prefix=$2
        shift 2
        ;;
      --prefix=*)
        prefix=${1#--prefix=}
        shift
        ;;
      --package)
        [ $# -ge 2 ] || die "--package needs an npm spec or a .tgz file"
        package=$2
        shift 2
        ;;
      --package=*)
        package=${1#--package=}
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  [ -n "$package" ] || die "--package needs an npm spec or a .tgz file"
  # A local tarball becomes an absolute path, so npm can't mistake it for a package name.
  if [ -f "$package" ]; then
    package=$(CDPATH='' cd -- "$(dirname -- "$package")" && pwd -P)/$(basename -- "$package")
  fi

  case $(uname -s) in
    MINGW* | MSYS* | CYGWIN*) die "on Windows, run this in PowerShell instead: npm install --global $NAME" ;;
  esac
  if [ "$(id -u)" -eq 0 ]; then
    warn "running as root. This installer never needs sudo; outside a container, run it as your own user."
  fi

  # 1. Node.js and npm
  command -v node >/dev/null 2>&1 || die "Overseer needs Node.js $MIN_NODE_MAJOR or newer, and 'node' is not on your PATH.
Install it from https://nodejs.org/en/download (or with a version manager such as nvm, fnm, mise or volta), then run this again."
  node_version=$(node -p 'process.versions.node' 2>/dev/null) || die "'node' is on your PATH but did not run."
  node_major=${node_version%%.*}
  case $node_major in
    '' | *[!0-9]*) die "could not read the Node.js version (got '$node_version')." ;;
  esac
  [ "$node_major" -ge "$MIN_NODE_MAJOR" ] || die "Overseer needs Node.js $MIN_NODE_MAJOR or newer; $(command -v node) is $node_version.
Upgrade from https://nodejs.org/en/download or with your version manager (for example: nvm install --lts), then run this again."
  command -v npm >/dev/null 2>&1 || die "'npm' is not on your PATH. Install a Node.js build that includes npm, then run this again."

  # 2. Where to install. Global installs write <prefix>/lib/node_modules and <prefix>/bin.
  if [ -z "$prefix" ]; then
    global_prefix=$(npm_global_prefix)
    if can_write "$global_prefix/lib/node_modules" && can_write "$global_prefix/bin"; then
      check_bin "$global_prefix"
      say "Installing $package into npm's global folder ($global_prefix)..."
      npm install --global --no-fund --no-audit "$package"
      bin_dir=$global_prefix/bin
    else
      prefix=$HOME/.local
      say "npm's global folder ($global_prefix) is not writable by $(id -un), and this installer never uses sudo."
      say "Installing for your user only, into $prefix. Your npm configuration is not changed."
    fi
  fi
  if [ -n "$prefix" ]; then
    mkdir -p "$prefix"
    prefix=$(CDPATH='' cd -- "$prefix" && pwd -P)
    check_bin "$prefix"
    say "Installing $package into $prefix..."
    npm install --global --prefix "$prefix" --no-fund --no-audit "$package"
    bin_dir=$prefix/bin
    prefix_flag=" --prefix \"$prefix\""
  else
    prefix_flag=""
  fi

  # 3. Check the result and say what to do next.
  [ -x "$bin_dir/overseer" ] || die "npm finished but $bin_dir/overseer is missing."
  version=$("$bin_dir/overseer" --version) || die "$bin_dir/overseer is installed but failed to start."

  say ""
  say "Overseer $version is installed at $bin_dir/overseer"
  if ! on_path "$bin_dir"; then
    say ""
    say "  $bin_dir is not on your PATH. To fix that (this installer doesn't edit your shell files):"
    path_hint "$bin_dir"
  else
    found=$(command -v overseer || true)
    if [ "$found" != "$bin_dir/overseer" ]; then
      warn "'overseer' on your PATH is $found, which comes before $bin_dir/overseer."
    fi
  fi
  say ""
  say "Next steps:"
  say "  overseer doctor     check Node.js, your API key and model access (well under \$0.001)"
  say "  overseer --help     every command"
  say "  overseer audit --auditor haiku --target haiku --budget 8"
  say "                      a first audit in the terminal, for about a cent"
  say ""
  say "Overseer needs an Anthropic API key. Set ANTHROPIC_API_KEY, or run one of the commands above in"
  say "a terminal: it asks once and can save the key in ~/.overseer/config.json, readable only by you."
  say ""
  say "Update:    npm install --global$prefix_flag $NAME@latest"
  say "Uninstall: npm uninstall --global$prefix_flag $NAME"
}

main "$@"
}
