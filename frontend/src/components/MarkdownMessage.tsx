// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import classes from "./MarkdownMessage.module.css";

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className={classes.markdown}>
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}
