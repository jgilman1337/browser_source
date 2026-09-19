/* global document, fetch */

// Cache the form controls used by the frontend.
const form = document.querySelector("#control-form");
const passwordInput = document.querySelector("#admin-password");
const operationInput = document.querySelector("#operation");
const result = document.querySelector("#result");

// Define the list of supported control operations.
const supportedOperations = {
	ping: "GET",
	admin_ping: "POST",
};

// Populate the operation menu from the supported backend routes.
Object.entries(supportedOperations).forEach(([path, method]) => {
	// Create a menu option formatted as "METHOD /path".
	const option = document.createElement("option");
	option.value = path;
	option.textContent = `${method} /${path}`;
	operationInput.append(option);
});

// Submit the selected control operation to the backend API.
form.addEventListener("submit", async (event) => {
	// Keep the browser on the frontend page instead of performing a full navigation.
	event.preventDefault();

	// Build the endpoint and authentication headers for the selected operation.
	const operation = operationInput.value;
	const method = supportedOperations[operation];
	const isAdminOperation = operation === "admin_ping";
	const endpoint = `/api/${operation}`;
	const headers = isAdminOperation ? { Authorization: `Bearer ${passwordInput.value}` } : {};

	// Give immediate feedback while the request is in progress.
	result.textContent = `Requesting ${endpoint}...`;

	try {
		// Use the HTTP method declared by the supported operation list.
		const response = await fetch(endpoint, {
			method,
			headers,
		});
		// Decode the JSON response returned by the backend.
		const body = await response.json();

		// Show the endpoint, HTTP status, and backend response in a readable format.
		result.textContent = JSON.stringify(
			{
				endpoint,
				status: response.status,
				timestamp: new Date().toISOString(),
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
