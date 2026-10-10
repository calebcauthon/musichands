PORT ?= 4173
# The teacher is a model on OpenRouter: set OPENROUTER_API_KEY and OPENROUTER_MODEL in the environment
# (and ELEVENLABS_API_KEY for the voice and the microphone). Without them the page has no Learn button.

.PHONY: dev test

dev: ## Serve the app and its workspaces on $(PORT), or the next free port after it
	@node server.js $(PORT) --find-port

test:
	node --test
