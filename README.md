# MyBatis Converter

This repository provides a lightweight tool for converting MyBatis Builder code to MySQL SQL directly in the browser or as a desktop app. It parses MyBatis Builder Java code (or XML) and generates equivalent MySQL statements, with support for placeholders and constants.

The project contains a Vite‑React frontend bundled as an Electron desktop app, and a command‑line interface for advanced use cases.



## Usage

### 1. Run the browser / Electron app
```bash
# Install dependencies
npm install

# Start in development mode (browser)
npm run dev

# Or start the Electron desktop app
npm start
```

The app will open a window where you can paste MyBatis Builder code, click **Convert** and get the MySQL output.

## Features
- Parse MyBatis Builder statements: `SELECT`, `FROM`, `WHERE`, `LEFT_OUTER_JOIN`, `INNER_JOIN`, etc.
- Automatic conversion of constants to placeholders.
- Supports `#{param}` style placeholders.
- Built as a single‑page Electron app for offline use.

## Contributing
Pull requests are welcome! Please open an issue first to discuss changes.

## License
MIT © 2026 MyBatis Converter Contributors
## Contributing
Pull requests are welcome! Please open an issue first to discuss changes.

## License
MIT © 2026 MyBatis Converter Contributors
