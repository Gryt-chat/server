#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Parse arguments ───────────────────────────────────────────────────
TARGET="windows-x64"
VERSION=""
SKIP_TSC=false
SKIP_SFU=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  VERSION="$2"; shift 2 ;;
    --skip-tsc) SKIP_TSC=true; shift ;;
    --skip-sfu) SKIP_SFU=true; shift ;;
    *)          TARGET="$1"; shift ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
fi

OUTDIR="$SCRIPT_DIR/dist-selfhosted/gryt-server-${TARGET}"
ZIP_NAME="gryt-server-${TARGET}-v${VERSION}.zip"
ZIP_PATH="$SCRIPT_DIR/dist-selfhosted/${ZIP_NAME}"

echo "=== Building Gryt Self-Hosted Server ==="
echo "  Target:  $TARGET"
echo "  Version: v$VERSION"
echo ""

# ── 1. Compile TypeScript ─────────────────────────────────────────────
if [ "$SKIP_TSC" = true ]; then
  echo "[1/4] Skipping TypeScript compilation (--skip-tsc)"
else
  echo "[1/4] Compiling TypeScript..."
  npx tsc
fi

# ── 2. Assemble distribution directory ────────────────────────────────
echo "[2/4] Assembling distribution package..."
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR/server"

cp -r dist/ "$OUTDIR/server/"

# Create a minimal package.json for production
node -e "
  const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
  delete pkg.devDependencies;
  delete pkg.dependencies['@aws-sdk/client-s3'];
  delete pkg.dependencies['@aws-sdk/s3-request-presigner'];
  pkg.version = '$VERSION';
  require('fs').writeFileSync('$OUTDIR/server/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

cp package-lock.json "$OUTDIR/server/" 2>/dev/null || true

echo "    Installing production dependencies..."
(cd "$OUTDIR/server" && npm install --omit=dev --ignore-scripts 2>/dev/null) || true

# Rebuild native modules if needed
(cd "$OUTDIR/server" && npx --yes node-gyp-build 2>/dev/null) || true

# Copy launcher and config
cp dist-selfhosted/config.env "$OUTDIR/"
cp dist-selfhosted/start.bat "$OUTDIR/"

# Create server launcher scripts
cat > "$OUTDIR/gryt_server.bat" <<'EOF'
@echo off
node server\index.js %*
EOF

cat > "$OUTDIR/gryt_server.sh" <<'SHEOF'
#!/bin/sh
node "$(dirname "$0")/server/index.js" "$@"
SHEOF
chmod +x "$OUTDIR/gryt_server.sh" 2>/dev/null || true

# ── 3. Cross-compile SFU ─────────────────────────────────────────────
if [ "$SKIP_SFU" = true ]; then
  echo "[3/4] Skipping SFU build (--skip-sfu)"
elif [ -f "$OUTDIR/gryt_sfu.exe" ] || [ -f "$OUTDIR/gryt_sfu" ]; then
  echo "[3/4] SFU binary already present, skipping build"
else
  echo "[3/4] Cross-compiling SFU..."
  SFU_DIR="$SCRIPT_DIR/../sfu"
  if [ -d "$SFU_DIR" ]; then
    case "$TARGET" in
      windows-x64)
        GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -C "$SFU_DIR" -o "$OUTDIR/gryt_sfu.exe" ./cmd/sfu/
        ;;
      linux-x64)
        GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -C "$SFU_DIR" -o "$OUTDIR/gryt_sfu" ./cmd/sfu/
        ;;
      *)
        echo "  Warning: Unknown target '$TARGET', skipping SFU build"
        ;;
    esac
  else
    echo "  Warning: SFU directory not found at $SFU_DIR, skipping SFU build"
  fi
fi

# ── 4. Create zip ─────────────────────────────────────────────────────
echo "[4/4] Creating zip archive..."
rm -f "$ZIP_PATH"
(cd "$SCRIPT_DIR/dist-selfhosted" && zip -qr "$ZIP_NAME" "gryt-server-${TARGET}/")

echo ""
echo "=== Build complete ==="
echo "  Directory: $OUTDIR/"
echo "  Zip:       $ZIP_PATH"
echo "  Size:      $(du -sh "$ZIP_PATH" | cut -f1)"
echo ""
