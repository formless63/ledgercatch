// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CommandPalette,
	createCommandRegistry,
} from "../src/components/command-system";

describe("reference command palette", () => {
	afterEach(() => cleanup());
	it("supports Mod+K, keyboard execution, and focus return", async () => {
		const execute = vi.fn();
		render(
			<CommandPalette commands={[{ id: "one", label: "One", execute }]} />,
		);
		const trigger = screen.getByRole("button", { name: "Open command menu" });
		trigger.focus();
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		const input = await screen.findByRole("combobox", {
			name: "Search commands",
		});
		await waitFor(() => expect(document.activeElement).toBe(input));
		fireEvent.keyDown(input, { key: "Enter" });
		expect(execute).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("waits for the scheduled frame before treating the mounted input as focused", async () => {
		const frames = new Map<number, FrameRequestCallback>();
		let nextFrame = 0;
		const request = vi
			.spyOn(globalThis, "requestAnimationFrame")
			.mockImplementation((callback) => {
				const id = ++nextFrame;
				frames.set(id, callback);
				return id;
			});
		const cancel = vi
			.spyOn(globalThis, "cancelAnimationFrame")
			.mockImplementation((id) => {
				frames.delete(id);
			});
		const view = render(<CommandPalette commands={[]} />);
		try {
			fireEvent.keyDown(document, { key: "k", ctrlKey: true });
			const input = await screen.findByRole("combobox", {
				name: "Search commands",
			});
			const dialog = screen.getByRole("dialog");
			act(() => dialog.focus());
			// DOM presence is not the focus contract: hold the actual scheduled
			// frame while the dialog, rather than its input, owns focus.
			expect(document.activeElement).toBe(dialog);
			expect(document.activeElement).not.toBe(input);
			expect(frames.size).toBeGreaterThan(0);
			const focused = waitFor(() => expect(document.activeElement).toBe(input));
			act(() => {
				const pending = [...frames.values()];
				frames.clear();
				for (const callback of pending) callback(performance.now());
			});
			await focused;
		} finally {
			view.unmount();
			request.mockRestore();
			cancel.mockRestore();
		}
	});

	it("suppresses Mod+K in editable controls", () => {
		render(
			<>
				<input aria-label="Editor" />
				<CommandPalette commands={[]} />
			</>,
		);
		const editor = screen.getByRole("textbox", { name: "Editor" });
		editor.focus();
		fireEvent.keyDown(editor, { key: "k", ctrlKey: true });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders a deterministic SSR shell without browser globals", () => {
		const html = renderToString(<CommandPalette commands={[]} />);
		expect(html).toContain("Open command menu");
		expect(html).not.toContain('role="dialog"');
	});

	it("tracks a focused second option instead of executing the first", async () => {
		const first = vi.fn();
		const second = vi.fn();
		render(
			<CommandPalette
				commands={[
					{ id: "one", label: "One", execute: first },
					{ id: "two", label: "Two", execute: second },
				]}
			/>,
		);
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		const input = await screen.findByRole("combobox");
		await waitFor(() => expect(document.activeElement).toBe(input));
		const options = screen.getAllByRole("option");
		const secondOption = options.at(1);
		if (!secondOption) throw new Error("second option missing");
		secondOption.focus();
		await waitFor(() =>
			expect(input.getAttribute("aria-activedescendant")).toBe("command-two"),
		);
		fireEvent.keyDown(secondOption, { key: "Enter" });
		fireEvent.click(secondOption);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("unregisters commands without retaining stale entries", () => {
		const registry = createCommandRegistry();
		const dispose = registry.register({
			id: "one",
			label: "One",
			execute: vi.fn(),
		});
		expect(registry.list()).toHaveLength(1);
		dispose();
		expect(registry.list()).toHaveLength(0);
	});

	it("latches duplicate clicks while async work is pending and reports rejection", async () => {
		let reject!: (error: Error) => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((_, fail) => {
					reject = fail;
				}),
		);
		render(
			<CommandPalette commands={[{ id: "slow", label: "Slow", execute }]} />,
		);
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		const option = await screen.findByRole("option", { name: "Slow" });
		fireEvent.click(option);
		fireEvent.click(option);
		expect(execute).toHaveBeenCalledTimes(1);
		reject(new Error("failed"));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("failed"),
		);
	});

	it("clears execution ownership after success so reopening can run again", async () => {
		const execute = vi.fn(async () => {});
		render(
			<CommandPalette commands={[{ id: "again", label: "Again", execute }]} />,
		);
		const trigger = screen.getByRole("button", { name: "Open command menu" });
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		fireEvent.click(await screen.findByRole("option", { name: "Again" }));
		await waitFor(() =>
			expect(document.querySelector('[role="dialog"]')).toBeNull(),
		);
		fireEvent.click(trigger);
		fireEvent.click(await screen.findByRole("option", { name: "Again" }));
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
	});

	it.each([
		"success",
		"rejection",
	] as const)("keeps a controlled reopened session open after stale %s", async (outcome) => {
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const execute = vi.fn(() =>
			execute.mock.calls.length === 1
				? new Promise<void>((res, rej) => {
						resolve = res;
						reject = rej;
					})
				: Promise.resolve(),
		);
		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Launch
					</button>
					<CommandPalette
						open={open}
						onOpenChange={setOpen}
						commands={[{ id: "delayed", label: "Delayed", execute }]}
					/>
				</>
			);
		}
		render(<Harness />);
		fireEvent.click(screen.getByRole("button", { name: "Launch" }));
		fireEvent.click(await screen.findByRole("option", { name: "Delayed" }));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
		if (outcome === "success") resolve();
		else reject(new Error("stale rejection"));
		await new Promise((done) => setTimeout(done, 10));
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(screen.getByRole("option", { name: "Delayed" }));
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
	});

	it("does not update or reject after StrictMode unmount", async () => {
		const onOpenChange = vi.fn();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		let settle!: (error?: Error) => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve, reject) => {
					settle = (error) => (error ? reject(error) : resolve());
				}),
		);
		const view = render(
			<StrictMode>
				<CommandPalette
					open
					onOpenChange={onOpenChange}
					commands={[{ id: "unmount", label: "Unmount", execute }]}
				/>
			</StrictMode>,
		);
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		fireEvent.click(await screen.findByRole("option", { name: "Unmount" }));
		onOpenChange.mockClear();
		view.unmount();
		settle(new Error("after unmount"));
		await new Promise((done) => setTimeout(done, 10));
		expect(execute).toHaveBeenCalledTimes(1);
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("hydrates without errors and still opens and executes by keyboard", async () => {
		const execute = vi.fn();
		const container = document.createElement("div");
		container.innerHTML = renderToString(
			<CommandPalette
				commands={[{ id: "hydrate", label: "Hydrate", execute }]}
			/>,
		);
		document.body.appendChild(container);
		const errors: unknown[] = [];
		const root = hydrateRoot(
			container,
			<CommandPalette
				commands={[{ id: "hydrate", label: "Hydrate", execute }]}
			/>,
			{ onRecoverableError: (error) => errors.push(error) },
		);
		await waitFor(() => expect(container.querySelector("button")).toBeTruthy());
		await new Promise((done) => setTimeout(done, 10));
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		const option = await screen.findByRole("option", { name: "Hydrate" });
		const input = screen.getByRole("combobox");
		await waitFor(() => expect(document.activeElement).toBe(input));
		fireEvent.keyDown(input, { key: "Enter" });
		expect(option).toBeTruthy();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(errors).toHaveLength(0);
		root.unmount();
	});
});
