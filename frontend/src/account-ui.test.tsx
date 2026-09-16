import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Failure } from "./account-ui";

afterEach(cleanup);

it("focuses a new error so feedback cannot remain above a long form", () => {
  const { rerender } = render(<Failure error={null} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  rerender(<Failure error={new Error("Ошибка действия")} />);
  expect(screen.getByRole("alert")).toHaveFocus();
});
