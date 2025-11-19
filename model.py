from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any


@dataclass
class RepositoryInfo:
  """Repository level information for the result payload."""

  name: str
  owner: str
  url: str


@dataclass
class FileChange:
  """Represents a single file affected by the pull request."""

  name: str
  path: str
  content: str
  diff: str


@dataclass
class PullRequestInfo:
  """A pull request summary and its affected files."""

  name: str
  url: str
  number: int
  files: List[FileChange] = field(default_factory=list)


@dataclass
class ReviewResult:
  """Root model returned by the action."""

  repository: RepositoryInfo
  pull_requests: List[PullRequestInfo] = field(default_factory=list)

  def to_dict(self) -> Dict[str, Any]:
    """Serialize the result into basic Python types, suitable for JSON."""
    return {
        "repository": asdict(self.repository),
        "pull_requests": [asdict(pr) for pr in self.pull_requests],
    }
