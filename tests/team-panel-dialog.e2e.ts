import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "node:test";

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Add member dialog preserves username focus and value across a parent rerender", { timeout: 30_000 }, async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    SVGElement: window.SVGElement,
    DocumentFragment: window.DocumentFragment,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: (time: number) => void) => window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => window.clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let root: { render: (node: unknown) => void; unmount: () => void } | undefined;
  let act: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;

  try {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    act = (React as unknown as { act: (callback: () => void | Promise<void>) => Promise<void> }).act;
    const { TeamPanel } = await import("../src/components/TeamPanel");

    const currentUser = {
      id: "user-admin",
      username: "owner",
      displayName: "Morgan Lee",
      role: "superadmin",
      status: "active",
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now(),
      linkedMachines: 0,
      online: true,
    };

    // Inline callbacks mirror the surrounding app: every parent render creates
    // fresh handlers, but TeamPanel and its open dialog must keep their state.
    function Parent({ nonce }: { nonce: number }) {
      return React.createElement(
        "div",
        { "data-parent-render": nonce },
        React.createElement(TeamPanel, {
          currentUser,
          onCurrentUserChange: () => undefined,
          onOpenHosts: () => undefined,
          onRefreshHosts: () => undefined,
          onToast: () => undefined,
        }),
      );
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    const renderParent = async (nonce: number) => {
      await act!(async () => {
        root!.render(React.createElement(Parent, { nonce }));
        await delay();
      });
    };

    const waitFor = async <T>(read: () => T | null, label: string): Promise<T> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = read();
        if (value) return value;
        await act!(async () => {
          await delay(10);
        });
      }
      throw new Error(`Timed out waiting for ${label}.`);
    };

    await renderParent(0);
    const addButton = await waitFor(
      () => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Add member")) ?? null,
      "the Add member button",
    );
    await act!(async () => {
      addButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await delay();
    });

    const dialog = await waitFor(
      () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Add a workspace member"]'),
      "the Add member dialog",
    );
    const allMachinesToggle = [...dialog.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("All workspace machines"),
    );
    assert(allMachinesToggle, "new members should default to the all-machines grant");
    assert.equal(
      allMachinesToggle.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      true,
      "the one-click all-machines grant is selected by default",
    );
    const usernameLabel = [...dialog.querySelectorAll("label")].find(
      (label) => label.querySelector("span")?.textContent?.trim() === "Username",
    );
    const username = usernameLabel?.querySelector("input");
    assert(username, "the Add member dialog should contain a username input");

    await waitFor(() => (document.activeElement === username ? username : null), "the username field focus");

    // A parent rerender happens before typing. The dialog must remain mounted.
    await renderParent(1);
    assert.equal(document.querySelector("[data-parent-render]")?.getAttribute("data-parent-render"), "1");
    assert.equal(document.activeElement, username, "the username field keeps focus after the parent rerender");
    assert.equal(document.querySelector('[role="dialog"][aria-label="Add a workspace member"]'), dialog);

    const setInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      assert(setter, "the input value setter should exist");
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    };

    await act!(async () => {
      setInputValue(username, "jordan");
      await delay();
    });
    assert.equal(username.value, "jordan");
    assert.equal(document.activeElement, username, "typing keeps focus in the username field");

    // A second parent rerender must not remount the dialog or discard the value.
    await renderParent(2);
    assert.equal(document.querySelector("[data-parent-render]")?.getAttribute("data-parent-render"), "2");
    assert.equal(document.activeElement, username, "the username field still has focus after the second parent rerender");
    assert.equal(username.value, "jordan", "the entered username survives the parent rerender");
    assert.equal(document.querySelector('[role="dialog"][aria-label="Add a workspace member"]'), dialog);
  } finally {
    try {
      if (root && act) {
        await act(async () => {
          root!.unmount();
        });
      }
    } catch {
      /* best effort */
    }
    dom.window.close();
  }
});
