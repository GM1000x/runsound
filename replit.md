# Runsound

## Overview

Runsound is an automated TikTok marketing pipeline for music artists. The project was imported from `https://github.com/GM1000x/runsound` into the workspace root.

## Stack

- **Runtime**: Node.js 18+
- **Package manager**: npm
- **Primary scripts**: Node.js CLI scripts in `scripts/`
- **Smart link server**: `smart-link/server.js`
- **Media tooling**: `fluent-ffmpeg`, `ffmpeg-static`, `@napi-rs/canvas`
- **External services used by code**: OpenAI and Supabase dependencies are installed, but credentials/configuration may be required before related scripts can run.

## Key Commands

- `npm install` — install project dependencies
- `npm run init` — initialize `runsound-marketing`
- `npm run onboard` — validate onboarding config
- `npm run generate` — generate slides/posts
- `npm run smart-link` — run the smart link server
- `npm run analytics` — check analytics
- `npm run report` — generate daily report
