import type { PullDetail } from "../api";
import { Avatar } from "./Avatar";

/** Who opened a pull request, as people read it: &run's own are "&run bot". */
export function authorName(pull: PullDetail): string {
  return pull.mine ? "&run bot" : pull.author;
}

/** The author's picture: the & badge for &run's own pull requests, else their GitHub avatar, else their initial. */
export function AuthorAvatar({ pull }: { pull: PullDetail }) {
  if (pull.mine) return <Avatar />;
  if (pull.authorAvatar) return <img src={pull.authorAvatar} alt={pull.author} title={pull.author} className="size-6 shrink-0 rounded-full bg-fill" />;
  return (
    <span role="img" aria-label={pull.author} className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fill text-[12px] font-semibold text-text-secondary uppercase">
      {pull.author.slice(0, 1)}
    </span>
  );
}
