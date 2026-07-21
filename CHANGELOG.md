# Changelog

All notable changes to this project will be documented in this file.

## 2026-07-21

- change: make the OTP access code reusable for the life of the server
  - Removed the single-use restriction, so a device can reconnect by entering the code again after its browser is closed and reopened.
  - The code can now authenticate more than one device; rate limiting on failed attempts is unchanged.
  - Restarting the server still rotates the code and invalidates existing sessions.

## 2026-02-15

- feat: enhance OTP authentication with rate limiting and lockout mechanism
- feat: implement OTP authentication for secure access
- - Added OTP authentication middleware to generate and verify a single-use 6-digit code on server startup.
- - Updated README to include authentication instructions and access code display.
- - Modified server to handle authentication routes and session management.
- - Enhanced client-side error handling for unauthorized access.
- - Introduced rate limiting for failed OTP attempts to improve security.
- - Updated constants for OTP settings.

## 2026-01-26

- Update CHANGELOG with recent improvements and fixes
- Improve mobile bridge UI responsiveness and fix update blocking
- Reduce snapshot polling intervals (300ms -> 200ms active, 1000ms -> 800ms idle)
- Add multiple rapid refreshes after sending messages (100ms, 300ms, 600ms, 1000ms)
- Fix isRendering flag getting stuck and blocking all UI updates
  - Add try-catch blocks with finally to ensure flag always resets
  - Add 2-second safety timeout to force-reset if stuck
- Fix double message issue by skipping send buttons in global click handler
- Remove manual input clearing to prevent race conditions with server-side injection
- Reduce message rate limit from 1000ms to 500ms

## 2026-01-25

- chore: bump version to 1.0.18 [skip ci]
- chore: bump version to 1.0.17 [skip ci]
- Update CHANGELOG.md
- chore: bump version to 1.0.15 [skip ci]
- fix: Improve file handling and editor snapshot capture
- Enhance file path cleaning in openFileInEditor() to handle quotes, markdown headers, and list markers
- Improve editor info banner styling with gradient background and warning icon
- Add file completion indicator showing "✓ Complete file" when full file is displayed
- Enhance line number display with better formatting and line count information
- Add error logging for failed file read operations
- Improve code comments and formatting for better maintainability

## 2026-01-24

- docs: Add Linux firewall troubleshooting guide and improve server output
- Add comprehensive Linux firewall troubleshooting section to README with UFW and iptables examples
- Improve server startup output formatting with consistent separator line length
- chore(server): Remove version tag and clean up formatting
- chore: add version tag to server.js
- chore: Remove unused import in click service

## 2026-01-23

- ci(release): Improve commit message handling in changelog generation
- fix(ui): Fix send button not clickable on mobile interface
- fix(ui): Remove placeholder text overlap in chat input
- fix(ui): Hide model descriptions in dropdown menu for cleaner UI
- feat(ui): Add support for ProseMirror/TipTap editor (in addition to Lexical)
- fix(server): Remove placeholder elements from captured HTML snapshots
- fix(client): Detect send button by data-variant="submit" attribute
- fix(client): Support codicon icon fonts (not just SVG icons)
- docs: Remove terminal panel references and add MIT license
- Simplify product description to focus on chat, files, and editor panels
- Add MIT License file for project
- Initial release
- Mobile web interface for monitoring Kiro IDE agent sessions
- Real-time chat, files, and editor panels
- WebSocket-based live updates
- Auto-discovery of Kiro instances on ports 9000-9003
