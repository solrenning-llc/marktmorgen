/**
 * Mutation testing of lib/money.ts (Claude 7, 13/11/2026): each case kills a
 * mutant that survived every test importing the module. Stripe's zero- and
 * three-decimal currencies outside the store list, the field prefix and the
 * price hint are pinned to what a person reads.
 */
import { decimalsOf, fieldPrefix, formatMoney, parseCurrency, plainAmount, priceExample } from "@/lib/money";
import { done, is, part } from "./check";

part("Currencies Stripe reports that a store cannot choose");
is("the won has no decimals", decimalsOf("krw"), 0);
is("a won amount is written whole", plainAmount(5000, "krw"), "5000");
is("the Kuwaiti dinar has three decimals", decimalsOf("KWD"), 3);
is("a dinar amount is written with three", plainAmount(1500, "kwd"), "1.500");
is("an unknown code has two", decimalsOf("xyz"), 2);
is("a won sale is formatted whole", formatMoney(5000, "krw"), "₩5,000");

part("Reading a stored currency");
is("a listed code with spaces and capitals", parseCurrency("  EUR "), "eur");
is("a number is the dollar", parseCurrency(978), "usd");
is("nothing is the dollar", parseCurrency(undefined), "usd");

part("Before a price field");
is("the dollar shows its code and symbol", fieldPrefix("usd"), "USD $");
is("the yen shows its code and symbol", fieldPrefix("jpy"), "JPY ¥");
is("the franc, whose symbol is its code, shows the code once", fieldPrefix("chf"), "CHF");

part("The price hint");
is("for the dollar", priceExample("usd"), "27 or 27.50");
is("for the yen, whole", priceExample("jpy"), "2700");
is("for the yen, another amount", priceExample("jpy", 9), "900");

done();
