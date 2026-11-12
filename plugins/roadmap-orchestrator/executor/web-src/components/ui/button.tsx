// shadcn/ui, new-york style (MIT), adapted to the console's control language: the look lives in styles.css (.ui-button).
import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.ts';
const buttonVariants = cva('ui-button', { variants: { variant: { outline: '', ghost: 'ui-button-ghost' }, size: { default: '', icon: 'ui-button-icon' } }, defaultVariants: { variant: 'outline', size: 'default' } });
export function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) { const Comp = asChild ? Slot.Root : 'button'; return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />; }
