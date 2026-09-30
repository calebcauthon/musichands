PORT ?= 4173

.PHONY: dev test

dev: ## Serve the app and its workspaces on $(PORT), or the next free port after it
	@node server.js $(PORT) --find-port

test:
	node --test
