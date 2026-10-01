PORT ?= 4173
# Who writes the lessons: claude (the `claude` command on this machine), or nothing for the ready-made wording
WRITER ?= claude

.PHONY: dev test

dev: ## Serve the app and its workspaces on $(PORT), or the next free port after it
	@MUSICHANDS_WRITER=$(WRITER) node server.js $(PORT) --find-port

test:
	node --test
