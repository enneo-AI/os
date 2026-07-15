-- Cover the task-comment foreign keys flagged by the database advisor.

create index if not exists pod_task_comments_task_pod_idx
  on public.pod_task_comments (task_id, pod_id);

create index if not exists pod_task_comments_author_idx
  on public.pod_task_comments (author_id);
