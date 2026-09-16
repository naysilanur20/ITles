import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

HTMLElement.prototype.scrollIntoView = vi.fn();
