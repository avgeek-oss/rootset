import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export const CommentMarkdown = memo(function CommentMarkdown({
  children,
}: {
  children: string;
}) {
  return (
    <div className="row-comment-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt, title }) =>
            src ? (
              <img
                src={src}
                alt={alt ?? ""}
                title={title}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              alt
            ),
          table: ({ children }) => (
            <div
              className="row-comment-table"
              role="region"
              aria-label="Comment table"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
