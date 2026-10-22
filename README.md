# Pi configs

This repo is a collection of various [Pi](https://github.com/earendil-works/pi) coding agent configs that I personally use.

## Installation

1. Clone this repository
1. Run `bootstrap` script, which creates symlink at `~/.pi` to cloned repository.
1. Open `pi` and it will automatically pick up extensions, skills and settings from the cloned repository

## Notes

- Runtime files (`agent/sessions/`, `agent/auth.json`, `agent/models-store.json`, `agent/trust.json`, `agent/npm/`) live inside the repository but are gitignored, see `.gitignore`
- `agent/auth.json` contains API keys and OAuth tokens — never commit it
