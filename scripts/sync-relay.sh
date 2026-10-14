#!/usr/bin/env sh
# Mirror the running relay (~/pi-relay) into this repo's relay/ directory.
#
# WHY: the relay that actually runs lives in ~/pi-relay, so the copy in this
# repo drifts the moment either side is edited. Run this after touching the
# relay, review the diff, then commit.
#
#   sh scripts/sync-relay.sh            # copy + show the diff
#   sh scripts/sync-relay.sh --check    # report drift only, change nothing
#
# README.en.md is repo-only (hand-maintained) and is never touched here.
set -eu

SRC="${PI_RELAY_SRC:-$HOME/pi-relay}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/relay"
FILES="pi-relay.mjs pi-relay-cli.mjs start.sh package.json package-lock.json README.md"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

[ -d "$SRC" ] || { echo "no relay source at $SRC (set PI_RELAY_SRC)"; exit 1; }

drift=0
for f in $FILES; do
  if [ ! -f "$SRC/$f" ]; then
    echo "  missing in source: $f"
    continue
  fi
  if ! cmp -s "$SRC/$f" "$DEST/$f"; then
    drift=1
    if [ "$CHECK" = 1 ]; then
      echo "  differs: relay/$f"
    else
      cp "$SRC/$f" "$DEST/$f"
      echo "  copied: relay/$f"
    fi
  fi
done

# Anything new in the source that this list does not know about would silently
# never be published, so say so instead.
for f in "$SRC"/*; do
  base="$(basename "$f")"
  case "$base" in
    token|logs|node_modules|package.json|package-lock.json) continue ;;
  esac
  [ -f "$f" ] || continue
  case " $FILES " in *" $base "*) ;; *) echo "  NOT mirrored (add to FILES if it is source): $base" ;; esac
done

# A token or a log inside the repo is a leak, not a drift.
for bad in token logs; do
  [ -e "$DEST/$bad" ] && echo "  ⚠️  $DEST/$bad exists — must never be committed"
done

if [ "$CHECK" = 1 ]; then
  [ "$drift" = 1 ] && { echo "drift detected (relay/ differs from $SRC)"; exit 2; }
  echo "relay/ is in sync with $SRC"
  exit 0
fi

if [ "$drift" = 0 ]; then
  echo "relay/ is in sync with $SRC (nothing copied)"
else
  echo
  echo "now: git -C \"$(dirname "$DEST")\" diff relay/ && git add relay/ && git commit"
fi
