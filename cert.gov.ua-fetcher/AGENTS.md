# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js data fetcher that collects cybersecurity incident reports from the Ukrainian CERT (cert.gov.ua) for dissertation research on Ukrainian cybersecurity threats. The fetcher systematically retrieves incident reports and stores them as JSON files for later analysis by the LLM-based processing framework.

## Common Commands

```bash
# Run the fetcher to collect new incident reports
npm start

# Install dependencies (currently none required beyond Node.js built-ins)
npm install
```

## Architecture

### Core Components

1. **fetcher.js** - Main fetching logic with two-phase approach:
   - Phase 1: Retrieve paginated article list from cert.gov.ua API
   - Phase 2: Fetch individual article details for each ID
   - Implements retry logic (3 attempts with exponential backoff)
   - ID mismatch detection and retry with cache-busting
   - Respectful rate limiting (1000ms delay between requests)

### Data Flow

```
cert.gov.ua API → fetcher.js → ../storage/cert.gov.ua/fetched/{id}.json
```

Each fetched article is stored as an individual JSON file named by its ID. The fetcher tracks already-fetched articles to avoid duplicates.

### Storage Structure

- **Fetched data**: `../storage/cert.gov.ua/fetched/` - Raw JSON files from cert.gov.ua API
- **File naming**: Articles stored as `{articleId}.json`

### Key Configuration

- **API Base URL**: `https://cert.gov.ua`
- **Language**: Ukrainian (`uk`)
- **Delay between requests**: 1000ms
- **Retry attempts**: 3 with exponential backoff
- **ID mismatch retry**: Automatic retry with 2-second delay and cache-busting

## Integration Context

This fetcher is part of a larger dissertation system:

1. **cert.gov.ua-fetcher** (this project) - Collects raw incident reports
2. **llm-basic-framework** - Processes collected data using multiple LLMs to extract structured information about cybersecurity incidents
3. **Storage** - Shared data storage location for both raw and processed data

## Key Features

### ID Mismatch Handling
The fetcher includes robust handling for cases where the cert.gov.ua API occasionally returns different article IDs than requested:

- **Automatic retry**: When ID mismatch is detected, the fetcher waits 2 seconds and retries with cache-busting parameters
- **Consistent naming**: Files are always saved using the requested ID as filename to maintain consistency with the article list
- **Metadata tracking**: Each saved file includes `_meta` information tracking both requested and actual IDs, fetch timestamp, and mismatch status
- **Browser-like headers**: Uses proper User-Agent and headers to mimic legitimate browser requests

### Rate Limiting Protection
- Uses 1-second delays between requests to be respectful to the server
- Implements exponential backoff on failures
- Cache-busting on retries to avoid server-side caching issues
- Additional 2-second delay before ID mismatch retries

## Development Notes

- No test suite currently exists
- Uses vanilla JavaScript (not TypeScript like the processing framework)
- Minimal external dependencies - relies on Node.js built-in modules
- Requires Node.js >= 18.0.0