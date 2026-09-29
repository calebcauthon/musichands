PORT ?= 4173

.PHONY: dev test

dev: ## Serve the app on $(PORT), or the next free port after it
	@python3 serve.py $(PORT)

test:
	node --test
