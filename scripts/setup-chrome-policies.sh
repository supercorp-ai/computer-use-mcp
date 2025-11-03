#!/bin/bash
# Setup Chrome policies for DuckDuckGo on local Mac/Linux

POLICY_DIR=""

# Detect OS and set policy directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    POLICY_DIR="/Library/Google/Chrome/NativeMessagingHosts"
    # Try Chrome policy directory (may need sudo)
    if [[ -d "/Library/Managed Preferences" ]]; then
        POLICY_DIR="/Library/Managed Preferences"
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    POLICY_DIR="/etc/opt/chrome/policies/managed"
fi

echo "Setting up DuckDuckGo as default search engine..."
echo "Policy directory: $POLICY_DIR"

# Create policy JSON
POLICY_JSON='{
  "DefaultSearchProviderEnabled": true,
  "DefaultSearchProviderName": "DuckDuckGo",
  "DefaultSearchProviderKeyword": "duckduckgo.com",
  "DefaultSearchProviderSearchURL": "https://duckduckgo.com/?q={searchTerms}",
  "DefaultSearchProviderSuggestURL": "https://duckduckgo.com/ac/?q={searchTerms}"
}'

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "⚠️  macOS requires manual setup:"
    echo "1. Open System Settings > Privacy & Security > Profiles"
    echo "2. Or use MDM/Jamf to deploy Chrome policies"
    echo ""
    echo "Alternatively, Chrome policies are set automatically in the Docker container."
    echo "Local development will use Google Search, production will use DuckDuckGo."
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux setup
    if [[ $EUID -ne 0 ]]; then
       echo "This script needs sudo to write to $POLICY_DIR"
       echo "Run: sudo $0"
       exit 1
    fi

    mkdir -p "$POLICY_DIR"
    echo "$POLICY_JSON" > "$POLICY_DIR/default-search.json"
    echo "✅ Chrome policies installed to $POLICY_DIR/default-search.json"
    echo "Restart Chrome for changes to take effect."
fi
