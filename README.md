# Local Service Manager

A small local-only dashboard to add, start, stop, and view logs for multiple Node.js repositories using `npm start`.

## Requirements
- Node.js installed
- Each service repository has a `package.json` with a `start` script
- Dependencies already installed in each repository (`npm install`)

## Run on Windows
1. Extract this folder somewhere convenient.
2. Open PowerShell or Command Prompt in this folder.
3. Run: `node server.js`
4. Open: http://127.0.0.1:4173

No npm packages are required by this dashboard.

## Add your services
For each service, enter a display name and the absolute path to the repository root (the folder containing `package.json`), for example:
`D:\Adams\common-service`

The dashboard always runs `npm start` in that folder. Added services are stored in `services.json`.

## Notes and limitations
- The dashboard binds only to 127.0.0.1 and is intended for local use. Do not expose it to your LAN or the internet.
- It does not execute arbitrary commands; it only runs `npm start`.
- Stop uses Windows `taskkill /T /F` on Windows to stop the process tree. On Linux/macOS it sends SIGTERM to the process group.
- Logs are kept in memory for the current manager session and the latest 500 lines per service.
- Closing the dashboard browser tab does not stop services. Stop services from the dashboard before closing the Node manager.
- This is a minimal starter utility, not a production process supervisor. For critical services, use PM2 or a dedicated supervisor.
