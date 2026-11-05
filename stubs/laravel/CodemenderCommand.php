<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Symfony\Component\Process\Process;

/**
 * php artisan codemender:run      — scan and complete everything
 * php artisan codemender:run scan — just report
 * php artisan codemender:run fix  — only fix failing checks
 *
 * Schedule it in routes/console.php (Laravel 11+) or app/Console/Kernel.php:
 *   Schedule::command('codemender:run')->hourly();
 */
class CodemenderCommand extends Command
{
    protected $signature = 'codemender:run {mode=run : run|scan|fix|todos|requirements|watch} {--dry-run} {--limit=} {--commit}';

    protected $description = 'Run the Codemender AI maintainer (finish TODOs, fix failing checks, implement requirements/*.md)';

    public function handle(): int
    {
        $args = ['npx', 'codemender', $this->argument('mode'), '--root', base_path()];
        if ($this->option('dry-run')) {
            $args[] = '--dry-run';
        }
        if ($this->option('limit')) {
            array_push($args, '--limit', (string) $this->option('limit'));
        }
        if ($this->option('commit')) {
            $args[] = '--commit';
        }

        $process = new Process($args, base_path(), null, null, null);
        $process->setTty(Process::isTtySupported());
        $process->run(function ($type, $buffer) {
            $this->output->write($buffer);
        });

        return $process->getExitCode() ?? self::FAILURE;
    }
}
