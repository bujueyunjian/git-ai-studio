import * as S from "@radix-ui/react-switch";
import { cn } from "../../lib/cn";

interface Props {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}

export function Switch({ checked, onCheckedChange, disabled, id, ...rest }: Props) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-slate-300 dark:data-[state=unchecked]:bg-slate-700",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <S.Thumb
        className={cn(
          "block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform",
          "data-[state=checked]:translate-x-[18px]",
        )}
      />
    </S.Root>
  );
}
