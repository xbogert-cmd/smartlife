import { Link } from 'react-router-dom';
import type { CourseGrade } from './types';

export function GradeStrip({ courses }: { courses: CourseGrade[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        Courses
      </h2>
      {courses.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No courses synced yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {courses.map((course) => (
            <li key={course.id}>
              <Link
                to={`/school/course/${course.id}`}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex flex-col">
                  <span style={{ color: 'var(--color-text)' }}>{course.name}</span>
                  {course.courseCode && (
                    <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {course.courseCode}
                    </span>
                  )}
                </div>
                <span style={{ color: 'var(--color-text)' }}>
                  {course.currentScore === null
                    ? '—'
                    : `${course.currentScore}%${course.currentGrade ? ` (${course.currentGrade})` : ''}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
