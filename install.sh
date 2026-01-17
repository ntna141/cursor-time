#!/bin/bash

set -e

echo "🔨 Compiling extension..."
npm run compile

echo "📦 Packaging extension..."
if command -v vsce &> /dev/null; then
    vsce package
else
    npx @vscode/vsce package
fi

VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "❌ Error: No .vsix file found"
    exit 1
fi

echo "📥 Installing extension: $VSIX_FILE"
code --install-extension "$VSIX_FILE" --force

echo "✅ Extension installed successfully!"
