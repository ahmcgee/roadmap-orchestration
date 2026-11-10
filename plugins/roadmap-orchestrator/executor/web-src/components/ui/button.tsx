// shadcn/ui, new-york style (MIT), adapted to the console's signal tokens.
import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.ts';
const buttonVariants = cva('ui-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50', { variants: { variant: { default: 'bg-primary text-primary-foreground hover:opacity-90', outline: 'border border-input bg-background hover:bg-accent', ghost: 'hover:bg-accent hover:text-accent-foreground' }, size: { default: 'h-8 px-3', icon: 'h-8 w-8' } }, defaultVariants: { variant: 'outline', size: 'default' } });
export function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) { const Comp = asChild ? Slot.Root : 'button'; return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />; }
