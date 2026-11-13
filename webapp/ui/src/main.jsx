// The dashboard starts here: the router, then React with the Fluent frame.
import React from "react";
import { createRoot } from "react-dom/client";
import { App, startRouter } from "./shell.jsx";

startRouter();
createRoot(document.getElementById("root")).render(<App />);
