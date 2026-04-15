import type { Page, CDPSession } from "@cloudflare/playwright";

export async function getPageSnapshot(
  page: Page,
  cdp: CDPSession
): Promise<string> {
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");

    const skipRoles = new Set([
      "generic",
      "text",
      "StaticText",
      "InlineTextBox",
      "linebreak",
      "presentation",
      "none"
    ]);

    const lines: string[] = [];
    let ref = 0;

    for (const node of nodes) {
      const roleValue = node.role?.value;
      if (!roleValue || skipRoles.has(String(roleValue))) continue;
      if (node.ignored) continue;

      ref++;
      const nameValue = node.name?.value;
      const name = nameValue ? ` name="${nameValue}"` : "";
      const descValue = node.description?.value;
      const description = descValue ? ` description="${descValue}"` : "";
      const valValue = node.value?.value;
      const value = valValue ? ` value="${valValue}"` : "";

      lines.push(`[${ref}] role=${roleValue}${name}${description}${value}`);
    }

    return lines.length > 0
      ? lines.join("\n")
      : "No interactive elements found on page.";
  } catch {
    const text = await page.evaluate(() => {
      const body = document.body;
      if (!body) return "Empty page";
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      const elements: string[] = [];
      let i = 1;
      const interactiveTags = new Set([
        "a",
        "button",
        "input",
        "select",
        "textarea"
      ]);
      const interactiveRoles = new Set([
        "button",
        "link",
        "textbox",
        "searchbox",
        "combobox",
        "menuitem",
        "tab",
        "checkbox",
        "radio",
        "switch"
      ]);
      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        if (interactiveTags.has(tag) || (role && interactiveRoles.has(role))) {
          const ariaLabel = el.getAttribute("aria-label");
          const label = el.getAttribute("label");
          const txt = el.textContent?.trim().slice(0, 100);
          const roleStr = role ?? tag;
          const nameStr = ariaLabel ?? label ?? txt ?? "";
          elements.push(`[${i}] role=${roleStr} name="${nameStr}"`);
          i++;
        }
      }
      return elements.length > 0
        ? elements.join("\n")
        : "No interactive elements found.";
    });
    return text;
  }
}
