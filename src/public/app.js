/* global document, fetch */

// Cache the form controls used by the frontend.
const form = document.querySelector("#control-form");
const passwordInput = document.querySelector("#admin-password");
const passwordToggle = document.querySelector("#password-toggle");
const operationInput = document.querySelector("#operation");
const operationParams = document.querySelector("#operation-params");
const result = document.querySelector("#result");

// Define the list of supported control operations.
const supportedOperations = {
	// Public endpoints.
	ping: { method: "GET" },
	uptime: { method: "GET" },

	// Admin endpoints.
	admin_ping: { method: "GET", auth: true },
	navigate: {
		method: "POST",
		auth: true,
		body: {
			newUrl: {
				type: "string",
				required: true,
			},
			clickPlayTarget: {
				type: "string",
				required: false,
			},
		},
	},
	reload: { method: "POST", auth: true },
};

/** HTML input type used for a schema field. */
const inputTypeBySchema = {
	string: "text",
	number: "number",
	url: "url",
};

// Populate the operation menu from the supported backend routes.
Object.entries(supportedOperations)
	.sort(([a], [b]) => a.localeCompare(b))
	.forEach(([path, operation]) => {
		// Create a menu option formatted as "METHOD /path".
		const option = document.createElement("option");
		option.value = path;
		option.textContent = `${operation.method} /${path}`;
		operationInput.append(option);
	});

// Rebuild the parameter fields whenever the selected operation changes.
const syncOperationParams = () => {
	const operation = supportedOperations[operationInput.value];
	const body = operation?.body ?? {};
	operationParams.replaceChildren();

	Object.entries(body).forEach(([key, field]) => {
		const fieldId = `param-${key}`;
		const wrapper = document.createElement("div");
		wrapper.className = "param-field";

		const label = document.createElement("label");
		label.htmlFor = fieldId;
		label.append(key, " ");
		const requirement = document.createElement("span");
		requirement.className = field.required ? "param-required" : "param-optional";
		requirement.textContent = field.required ? "(required)" : "(optional)";
		label.append(requirement);

		const valueRow = document.createElement("div");
		valueRow.className = "param-value";

		const input = document.createElement("input");
		input.id = fieldId;
		input.name = key;
		input.type = inputTypeBySchema[field.type] ?? "text";
		input.placeholder = "Value";
		input.autocomplete = "off";
		input.dataset.required = field.required ? "true" : "false";
		if (field.required) {
			input.setAttribute("aria-required", "true");
		}

		const clear = document.createElement("button");
		clear.type = "button";
		clear.className = "icon-button param-clear";
		clear.setAttribute("aria-label", `Clear ${key}`);
		clear.addEventListener("click", () => {
			input.value = "";
			input.focus();
		});

		const icon = document.createElement("span");
		icon.className = "close-icon";
		icon.setAttribute("aria-hidden", "true");
		clear.append(icon);

		valueRow.append(input, clear);
		wrapper.append(label, valueRow);
		operationParams.append(wrapper);
	});
};
operationInput.addEventListener("change", syncOperationParams);
syncOperationParams();

// Toggle the password field between masked and visible text.
passwordToggle.addEventListener("click", () => {
	// Determine the next visibility state from the current input type.
	const isVisible = passwordInput.type === "text";
	passwordInput.type = isVisible ? "password" : "text";
	// Swap the eye icon to match the new password visibility state.
	passwordToggle.classList.toggle("is-visible", !isVisible);
	// Keep the accessible label synchronized with the next action.
	passwordToggle.setAttribute("aria-label", isVisible ? "Show admin password" : "Hide admin password");
});

/** Collect JSON body fields from the generated parameter inputs. */
const readOperationBody = (operation) => {
	const schema = operation.body ?? {};
	const body = {};

	for (const [key, field] of Object.entries(schema)) {
		const input = operationParams.querySelector(`[name="${key}"]`);
		const value = input?.value.trim() ?? "";
		if (!value) {
			if (field.required) {
				return { error: `${key} is required` };
			}
			continue;
		}
		body[key] = field.type === "number" ? Number(value) : value;
	}

	return { body };
};

// Submit the selected control operation to the backend API.
form.addEventListener("submit", async (event) => {
	// Keep the browser on the frontend page instead of performing a full navigation.
	event.preventDefault();

	// Build the endpoint and authentication headers for the selected operation.
	const name = operationInput.value;
	const operation = supportedOperations[name];
	const endpoint = `/api/${name}`;
	const headers = operation.auth ? { Authorization: `Bearer ${passwordInput.value}` } : {};
	const parsed = readOperationBody(operation);

	if (parsed.error) {
		result.textContent = JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				endpoint,
				error: parsed.error,
			},
			null,
			2,
		);
		return;
	}

	if (operation.body) {
		headers["Content-Type"] = "application/json";
	}

	// Give immediate feedback while the request is in progress.
	result.textContent = `Requesting ${endpoint}...`;

	try {
		// Use the HTTP method declared by the supported operation list.
		const response = await fetch(endpoint, {
			method: operation.method,
			headers,
			body: operation.body ? JSON.stringify(parsed.body) : undefined,
		});
		// Decode the JSON response returned by the backend.
		const body = await response.json();

		// Show the endpoint, HTTP status, and backend response in a readable format.
		result.textContent = JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				endpoint,
				status: response.status,
				response: body,
			},
			null,
			2,
		);
	} catch (error) {
		// Show a safe client-side error when the request or response parsing fails.
		result.textContent = JSON.stringify(
			{
				endpoint,
				timestamp: new Date().toISOString(),
				error: error instanceof Error ? error.message : "Request failed",
			},
			null,
			2,
		);
	}
});
