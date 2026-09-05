PORT ?= 4173

.PHONY: dev test

dev: ## Serve the app at http://localhost:$(PORT)
	@echo "Serving on http://localhost:$(PORT)/"
	python3 -m http.server $(PORT)

test:
	node --test
