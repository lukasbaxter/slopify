"""Constants for the Slopify integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "slopify"

CONF_TOKEN: Final = "token"
CONF_USER_ID: Final = "user_id"
CONF_DEFAULT_SOURCE: Final = "default_source"

# Sentinel for "no default source": start where the session last played.
DEFAULT_SOURCE_LAST: Final = "last"

# What this integration calls itself on the server: the login (shown in
# Slopify's list of signed-in devices) and the session client.
CLIENT_NAME: Final = "Home Assistant"
CLIENT_KIND: Final = "homeassistant"

# Thumbnail size asked of /api/image for the media browser and the player card.
BROWSE_IMAGE_SIZE: Final = 320
PLAYER_IMAGE_SIZE: Final = 640

# The media browser lists a long library under letter folders.
LETTER_FOLDERS_OVER: Final = 300
